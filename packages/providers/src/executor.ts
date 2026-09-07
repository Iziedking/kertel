/**
 * The one impure part of the research loop.
 *
 * `decideNextStep` decides what to buy; this performs it and folds the answer
 * back into an observation. Everything that can go wrong with a paid call goes
 * wrong here, and the whole design of this module is the difference between the
 * three ways it can go wrong:
 *
 *   - **Nothing was spent.** The provider was down, the budget would not cover
 *     it, the wallet is missing. Cost zero, status `unavailable`, and the
 *     planner routes around it.
 *   - **Money moved and the data is unusable.** The call was paid for and the
 *     answer did not normalise. Cost is the amount paid, status `invalid`. The
 *     spend is real and must appear in the budget and in the receipt even
 *     though Kertel got nothing for it. Quietly zeroing that is how a daily cap
 *     stops meaning anything.
 *   - **Money may or may not have moved.** A payment was signed and no answer
 *     came back. Charged against the budget as if it settled, because the
 *     pessimistic assumption is the only one that cannot overspend — and then
 *     the run stops buying. An unresolved payment means Kertel cannot say what
 *     it has spent, and a budget it cannot count is not a budget. The attempt
 *     is surfaced on `unresolvedPayment()` so the caller can persist it, engage
 *     the safety state, and reconcile it against the chain later. Free evidence
 *     keeps flowing; only the spending stops.
 *
 * Nothing here decides *whether* to spend. That is `evaluatePaidCall`, which is
 * called again against the live quote: the planner works from an estimate, and
 * the provider's actual price is the one that has to clear the caps.
 */

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { KertelDefect, addSeconds, refuse } from "@kertel/core/domain";
import type {
  Clock,
  EvidenceId,
  EvidenceObservation,
  EvidenceStatus,
  Instant,
  PaymentAttemptId,
  Refusal,
} from "@kertel/core/domain";
import { evaluatePaidCall } from "@kertel/core/policy";
import type { Policy } from "@kertel/core/policy";
import type { RecipeStep, StepExecutor } from "@kertel/core/research";
import type { Hasher, PaidRequest, X402Client, X402Quote } from "@kertel/x402";

import { adapterFor } from "./registry.js";
import type { InstrumentIds } from "./symbols.js";
import type { Normalized, ProviderAdapter } from "./types.js";

const FREE_CALL_TIMEOUT_MS = 8_000;

/**
 * One line per paid attempt, whatever the outcome.
 *
 * Written even when the call failed, because "Kertel tried to buy this and
 * could not" is the part of a cheap run a user most needs to see. Receipts are
 * built from these.
 */
export type PaymentRecord = {
  readonly attemptId: PaymentAttemptId;
  readonly provider: string;
  readonly endpointId: string;
  readonly quotedUsdc: FixedPoint | null;
  readonly chargedUsdc: FixedPoint;
  readonly rail: string | null;
  readonly facilitator: string | null;
  readonly settlementTx: string | null;
  readonly outcome: "paid" | "free" | "refused" | "unknown";
  readonly refusalCode: string | null;
  readonly at: Instant;
};

export type ExecutorConfig = {
  readonly policy: Policy;
  readonly x402: X402Client;
  readonly clock: Clock;
  readonly hash: Hasher;
  readonly instrument: InstrumentIds;
  /** Spent on other runs today, before this one started. */
  readonly spentTodayBefore: FixedPoint;
  /**
   * Already spent on *this* run before this executor was built.
   *
   * Non-zero when a run is resumed after a restart. Without it the caps would
   * be checked against this executor's own tally, and a run that crashed
   * halfway would get its per-run budget back on the way up.
   */
  readonly spentThisRunBefore?: FixedPoint;
  readonly newEvidenceId: () => EvidenceId;
  readonly newPaymentAttemptId: () => PaymentAttemptId;
  /** Only ever used for the free venue read. Paid calls go through `x402`. */
  readonly fetchImpl?: typeof globalThis.fetch;
};

export type ResearchExecution = {
  /** Hand this to `runPlan`. */
  readonly execute: StepExecutor;
  /** What this executor has charged against the budget. */
  spentThisRun(): FixedPoint;
  payments(): readonly PaymentRecord[];
  /**
   * The payment that was signed and never answered, if one was.
   *
   * Set means the run stopped buying and there is an amount Kertel cannot
   * account for. The caller is expected to persist it and engage the safety
   * state; a reconciliation pass resolves it later against the chain.
   */
  unresolvedPayment(): PaymentAttemptId | null;
};

const ZERO = fp.parse("0.00");

function normalizedRefusal(refusal: Refusal): Normalized {
  return Object.freeze({
    refusalCode: refusal.code,
    refusalDetail: refusal.detail,
  });
}

function unrecognised(provider: string, paidNote: string): Refusal {
  return refuse(
    "PROVIDER_UNAVAILABLE",
    `${provider}${paidNote} answered in a shape Kertel does not recognise.`,
    { provider },
  ).error;
}

export function makeStepExecutor(config: ExecutorConfig): ResearchExecution {
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const spentBefore = config.spentThisRunBefore ?? ZERO;
  let spent = ZERO;
  let unresolved: PaymentAttemptId | null = null;
  const payments: PaymentRecord[] = [];

  function observation(input: {
    readonly step: RecipeStep;
    readonly status: EvidenceStatus;
    readonly normalized: Normalized;
    readonly sourceUrl: string;
    readonly rawPayloadHash: string | null;
    readonly cost: FixedPoint;
    readonly paymentAttemptId: PaymentAttemptId | null;
  }): EvidenceObservation {
    const observedAt = config.clock.now();
    return {
      id: config.newEvidenceId(),
      provider: input.step.provider,
      capability: input.step.capability,
      endpointId: input.step.endpointId,
      status: input.status,
      observedAt,
      freshnessDeadline: addSeconds(observedAt, input.step.freshness),
      normalized: input.normalized,
      rawPayloadHash: input.rawPayloadHash,
      sourceUrl: input.sourceUrl,
      costUsdc: input.cost,
      paymentAttemptId: input.paymentAttemptId,
    };
  }

  function unavailable(
    step: RecipeStep,
    refusal: Refusal,
    sourceUrl: string,
  ): { observation: EvidenceObservation; cost: FixedPoint } {
    return {
      observation: observation({
        step,
        status: "unavailable",
        normalized: normalizedRefusal(refusal),
        sourceUrl,
        rawPayloadHash: null,
        cost: ZERO,
        paymentAttemptId: null,
      }),
      cost: ZERO,
    };
  }

  function record(entry: PaymentRecord): PaymentAttemptId {
    payments.push(entry);
    return entry.attemptId;
  }

  /** Tier 0. No wallet, no challenge, no spend. */
  async function runFree(
    step: RecipeStep,
    adapter: ProviderAdapter,
    request: PaidRequest,
  ): Promise<{ observation: EvidenceObservation; cost: FixedPoint }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? FREE_CALL_TIMEOUT_MS);
    let rawText: string;
    let status: number;
    try {
      const response = await doFetch(request.url, {
        method: request.method,
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      status = response.status;
      rawText = await response.text();
    } catch (cause) {
      return unavailable(
        step,
        refuse("PROVIDER_UNAVAILABLE", `${step.provider} could not be reached for the venue price.`, {
          provider: step.provider,
          reason: cause instanceof Error ? cause.name : "unknown",
        }).error,
        request.url,
      );
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
      return unavailable(
        step,
        refuse("PROVIDER_UNAVAILABLE", `${step.provider} answered ${String(status)}.`, {
          provider: step.provider,
          status,
        }).error,
        request.url,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      body = rawText;
    }

    const normalized = adapter.normalize(body, { instrument: config.instrument });
    return {
      observation: observation({
        step,
        status: normalized === null ? "invalid" : "valid",
        normalized: normalized ?? normalizedRefusal(unrecognised(step.provider, "")),
        sourceUrl: request.url,
        rawPayloadHash: config.hash(rawText),
        cost: ZERO,
        paymentAttemptId: null,
      }),
      cost: ZERO,
    };
  }

  /** Tiers 1 to 3. Quote, approve against the live price, pay, normalise. */
  async function runPaid(
    step: RecipeStep,
    adapter: ProviderAdapter,
    request: PaidRequest,
  ): Promise<{ observation: EvidenceObservation; cost: FixedPoint }> {
    // An earlier call in this run was signed and never answered. Kertel does
    // not know whether that money moved, so it does not know what it has left,
    // and buying more on an uncountable budget is how a cap gets exceeded while
    // every individual check passes. Free evidence still flows.
    if (unresolved !== null) {
      return unavailable(
        step,
        refuse(
          "X402_PAYMENT_UNRESOLVED",
          "An earlier payment in this run was signed and never confirmed, so Kertel stopped buying evidence until that is resolved.",
          { provider: step.provider, unresolvedAttempt: unresolved },
        ).error,
        request.url,
      );
    }

    const quoted = await config.x402.quote(request);
    if (!quoted.ok) {
      record({
        attemptId: config.newPaymentAttemptId(),
        provider: step.provider,
        endpointId: step.endpointId,
        quotedUsdc: null,
        chargedUsdc: ZERO,
        rail: null,
        facilitator: null,
        settlementTx: null,
        outcome: "refused",
        refusalCode: quoted.error.code,
        at: config.clock.now(),
      });
      return unavailable(step, quoted.error, request.url);
    }

    // A provider that stopped charging is a real event, not an error. Kertel
    // takes the free answer and reports that the call cost nothing.
    if (quoted.value.kind === "free") {
      const free = quoted.value.response;
      const normalized = adapter.normalize(free.body, { instrument: config.instrument });
      record({
        attemptId: config.newPaymentAttemptId(),
        provider: step.provider,
        endpointId: step.endpointId,
        quotedUsdc: ZERO,
        chargedUsdc: ZERO,
        rail: null,
        facilitator: null,
        settlementTx: null,
        outcome: "free",
        refusalCode: null,
        at: config.clock.now(),
      });
      return {
        observation: observation({
          step,
          status: normalized === null ? "invalid" : "valid",
          normalized: normalized ?? normalizedRefusal(unrecognised(step.provider, "")),
          sourceUrl: request.url,
          rawPayloadHash: free.bodyHash,
          cost: ZERO,
          paymentAttemptId: null,
        }),
        cost: ZERO,
      };
    }

    const quote: X402Quote = quoted.value.quote;

    // The planner used an estimate to decide this step was worth taking. This is
    // the provider's actual price, and it is the one that has to clear the caps.
    const allowed = evaluatePaidCall({
      policy: config.policy,
      quotedUsdc: quote.amount,
      alreadySpentThisRun: fp.add(spentBefore, spent),
      alreadySpentToday: fp.add(config.spentTodayBefore, spent),
      walletConfigured: config.x402.walletConfigured,
    });
    if (!allowed.ok) {
      record({
        attemptId: config.newPaymentAttemptId(),
        provider: step.provider,
        endpointId: step.endpointId,
        quotedUsdc: quote.amount,
        chargedUsdc: ZERO,
        rail: quote.rail,
        facilitator: quote.facilitator,
        settlementTx: null,
        outcome: "refused",
        refusalCode: allowed.error.code,
        at: config.clock.now(),
      });
      return unavailable(step, allowed.error, request.url);
    }

    const paid = await config.x402.pay(request, {
      quote,
      approvedAmount: quote.amount,
      approvedAt: config.clock.now(),
    });

    if (!paid.ok) {
      // The one failure that still costs money. A signed authorisation with no
      // answer may have settled, so it is charged as though it did.
      const unknown = paid.error.code === "X402_PAYMENT_UNKNOWN";
      const chargedUsdc = unknown ? quote.amount : ZERO;
      if (unknown) {
        spent = fp.add(spent, chargedUsdc);
      }
      const attemptId = record({
        attemptId: config.newPaymentAttemptId(),
        provider: step.provider,
        endpointId: step.endpointId,
        quotedUsdc: quote.amount,
        chargedUsdc,
        rail: quote.rail,
        facilitator: quote.facilitator,
        settlementTx: null,
        outcome: unknown ? "unknown" : "refused",
        refusalCode: paid.error.code,
        at: config.clock.now(),
      });
      if (unknown) {
        // Latched for the rest of the run, and surfaced so the caller can
        // persist it and engage the safety state.
        unresolved = attemptId;
      }

      return {
        observation: observation({
          step,
          status: "unavailable",
          normalized: normalizedRefusal(paid.error),
          sourceUrl: request.url,
          rawPayloadHash: null,
          cost: chargedUsdc,
          paymentAttemptId: unknown ? attemptId : null,
        }),
        cost: chargedUsdc,
      };
    }

    const response = paid.value;
    spent = fp.add(spent, response.amountPaid);
    const attemptId = record({
      attemptId: config.newPaymentAttemptId(),
      provider: step.provider,
      endpointId: step.endpointId,
      quotedUsdc: quote.amount,
      chargedUsdc: response.amountPaid,
      rail: quote.rail,
      facilitator: quote.facilitator,
      settlementTx: response.settlement?.transaction ?? null,
      outcome: "paid",
      refusalCode: null,
      at: config.clock.now(),
    });

    const normalized = adapter.normalize(response.body, { instrument: config.instrument });
    return {
      observation: observation({
        step,
        // Paid for and unusable. The status says so, and the cost still counts.
        status: normalized === null ? "invalid" : "valid",
        normalized:
          normalized ??
          normalizedRefusal(
            unrecognised(step.provider, ` was paid ${fp.format(response.amountPaid)} and`),
          ),
        sourceUrl: request.url,
        rawPayloadHash: response.bodyHash,
        cost: response.amountPaid,
        paymentAttemptId: attemptId,
      }),
      cost: response.amountPaid,
    };
  }

  const execute: StepExecutor = async (step: RecipeStep) => {
    const adapter = adapterFor(step.id);
    if (adapter === undefined) {
      // `assertRegistryCoversRecipes` runs at startup precisely so this cannot
      // be reached with money already spent.
      throw new KertelDefect(`no provider adapter for recipe step ${step.id}`);
    }

    const built = adapter.buildRequest({ instrument: config.instrument });
    if (!built.ok) {
      return unavailable(step, built.error, `${step.provider}:${step.capability}`);
    }

    return adapter.paid ? runPaid(step, adapter, built.value) : runFree(step, adapter, built.value);
  };

  return {
    execute,
    spentThisRun: () => spent,
    payments: () => payments,
    unresolvedPayment: () => unresolved,
  };
}
