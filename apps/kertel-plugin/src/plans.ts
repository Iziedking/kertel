/**
 * Creating, approving and reading exit plans.
 *
 * The plan is where the human's judgement enters and the agent's autonomy
 * begins. They see the actual prices each leg will fire at — not the
 * percentages they typed, the prices — approve it once with a one-use code, and
 * from then on Kertel manages the position without asking again.
 *
 * Showing prices rather than percentages is the whole of the honesty here.
 * "Sell a third at +25%" is a preference; "sell 0.0999 ETH at 2500.00" is a
 * commitment, and only one of them can be checked against what actually
 * happened.
 */

import { randomUUID } from "node:crypto";

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { addSeconds, formatInstant, refuse } from "@kertel/core/domain";
import type { Instant, Refusal, SenderIdHash, Symbol_ } from "@kertel/core/domain";
import { effectiveStopBps, priceAtBps, validateMandate } from "@kertel/core/mandates";
import type { ExitMandate, LadderRung, MandateId, TrailingStop } from "@kertel/core/mandates";
import {
  generateConfirmationCode as makeCode,
  hashConfirmationCode,
  normalizeConfirmationCode,
} from "@kertel/core/confirmation";

import type { BinanceClient } from "./infra/binance.js";
import type { Store } from "./infra/store.js";

export type PlanDeps = {
  readonly store: Store;
  readonly binance: BinanceClient;
  readonly hash: (input: string) => string;
  readonly random: (count: number) => Uint8Array;
  readonly now: () => Instant;
  readonly ownerHash: SenderIdHash | null;
  readonly mode: "fixture" | "live";
  /** Ceiling on any single leg, so a plan cannot promise the impossible. */
  readonly maxLegBps: number;
  readonly planTtlSeconds: number;
};

export type PlanOutcome = {
  readonly ok: boolean;
  readonly body: string;
  readonly refusalCode: string | null;
};

function fail(refusal: Refusal): PlanOutcome {
  return { ok: false, refusalCode: refusal.code, body: refusal.detail };
}

export type PlanRequest = {
  readonly symbol: string;
  /** Rungs as "bps:sharebps" pairs, ascending. */
  readonly ladder: readonly LadderRung[];
  readonly stopLossBps: number | null;
  readonly trailing: TrailingStop | null;
  readonly breakevenAtBps: number | null;
  /** Null means "everything the account currently holds". */
  readonly quantity: string | null;
  /** Null means "what the position actually cost", read from the last fill. */
  readonly entryPrice: string | null;
  readonly holdDays: number;
};

/**
 * Take over a position somebody else opened.
 *
 * An order placed through Binance Agent OS lands in the Agentic sub-account and
 * Kertel never sees the fill. It can read the resulting balance, but a balance
 * does not say what the position cost — and without that, every exit rule is
 * measured from the wrong number. A stop "15% below what I paid" quietly becomes
 * "15% below wherever it is now", which is not the same instruction and is not
 * the one anybody approved.
 *
 * So adoption is explicit: state what it cost, Kertel verifies the position is
 * actually there, and from then on plans for that symbol measure from the real
 * entry.
 */
export async function adoptPosition(
  deps: PlanDeps,
  input: {
    readonly symbol: string;
    readonly quantity: string;
    readonly entryPrice: string;
    readonly source: string;
  },
): Promise<PlanOutcome> {
  const now = deps.now();
  const symbol = input.symbol.trim().toUpperCase() as Symbol_;

  if (!/^\d+(\.\d+)?$/.test(input.entryPrice.trim()) || !/^\d+(\.\d+)?$/.test(input.quantity.trim())) {
    return fail(
      refuse("AMOUNT_NOT_UNDERSTOOD", "The quantity and entry price must both be plain decimal amounts.")
        .error,
    );
  }

  const entryPrice = fp.parse(input.entryPrice.trim());
  const quantity = fp.parse(input.quantity.trim());
  if (!fp.isPositive(entryPrice) || !fp.isPositive(quantity)) {
    return fail(
      refuse("AMOUNT_NOT_UNDERSTOOD", "The quantity and entry price must both be greater than zero.").error,
    );
  }

  const [filtersResult, accountResult] = await Promise.all([
    deps.binance.filters(symbol),
    deps.binance.account(),
  ]);
  if (!filtersResult.ok) return fail(filtersResult.error);
  if (!accountResult.ok) return fail(accountResult.error);

  const base = filtersResult.value.baseAsset;
  const held =
    accountResult.value.balances.find((balance) => balance.asset === base)?.free ?? fp.parse("0");

  // The claim is checked against the account, not taken on trust. Adopting a
  // position that is not there would hand the monitor a rule it can never obey.
  if (fp.lessThan(held, quantity)) {
    return fail(
      refuse(
        "INSUFFICIENT_BALANCE",
        `You said ${fp.format(quantity)} ${base} but the account holds ${fp.format(held)}. Kertel will not adopt a position it cannot see.`,
      ).error,
    );
  }

  deps.store.mandates.adopt({
    symbol,
    entryPrice: fp.format(entryPrice),
    quantity: fp.format(quantity),
    source: input.source,
    at: now,
  });
  deps.store.mandates.journal({
    at: now,
    kind: "mandate_created",
    symbol,
    mandateId: null,
    headline: `Took over ${fp.format(quantity)} ${base} opened via ${input.source}`,
    detail: `Entry ${fp.format(entryPrice)}; verified against a balance of ${fp.format(held)} ${base}. Exit plans for ${symbol} now measure from that entry.`,
    evidence: null,
  });

  return {
    ok: true,
    refusalCode: null,
    body: [
      `Kertel has taken over ${fp.format(quantity)} ${base}.`,
      "",
      `Opened via:  ${input.source}`,
      `Entry:       ${fp.format(entryPrice)} ${filtersResult.value.quoteAsset}`,
      `Verified:    account holds ${fp.format(held)} ${base}`,
      "",
      "Exit plans for this symbol now measure from that entry price rather than the",
      "current bid. Use kertel_plan_exit to hand it a set of rules to manage it by.",
    ].join("\n"),
  };
}

/**
 * Draft a plan and issue the code that arms it.
 *
 * Nothing is watched until the code comes back. A plan that started managing a
 * position the moment it was described would make the approval decorative.
 */
export async function planExit(deps: PlanDeps, request: PlanRequest): Promise<PlanOutcome> {
  const now = deps.now();
  const symbol = request.symbol.trim().toUpperCase() as Symbol_;

  if (deps.ownerHash === null) {
    return fail(
      refuse("SENDER_NOT_ALLOWED", "Kertel has no configured owner, so it will not arm a plan.").error,
    );
  }

  const safety = deps.store.safetyState();
  if (safety.killSwitchEngaged) {
    return fail(
      refuse("KILL_SWITCH_ENGAGED", `Kertel is stopped: ${safety.killSwitchReason ?? "no reason recorded"}.`)
        .error,
    );
  }

  const [filtersResult, marketResult, accountResult] = await Promise.all([
    deps.binance.filters(symbol),
    deps.binance.market(symbol),
    deps.binance.account(),
  ]);
  if (!filtersResult.ok) return fail(filtersResult.error);
  if (!marketResult.ok) return fail(marketResult.error);
  if (!accountResult.ok) return fail(accountResult.error);

  const filters = filtersResult.value;
  const market = marketResult.value;
  const held =
    accountResult.value.balances.find((balance) => balance.asset === filters.baseAsset)?.free ??
    fp.parse("0");

  // Default to the whole position: a plan that silently covers part of what you
  // hold leaves the rest unprotected without saying so.
  const quantity = request.quantity === null ? held : fp.parse(request.quantity);
  if (!fp.isPositive(quantity)) {
    return fail(
      refuse(
        "INSUFFICIENT_BALANCE",
        `The account holds no ${filters.baseAsset}, so there is no position to plan an exit for.`,
      ).error,
    );
  }
  if (fp.greaterThan(quantity, held)) {
    return fail(
      refuse(
        "INSUFFICIENT_BALANCE",
        `The plan covers ${fp.format(quantity)} ${filters.baseAsset} but the account only holds ${fp.format(held)}.`,
      ).error,
    );
  }

  // What the position actually cost, in order of reliability: what the user
  // stated, then what was recorded when the position was adopted, then the
  // current bid. The last is only right for a position opened moments ago, so
  // the plan message says which was used.
  const adopted = deps.store.mandates.adopted(symbol);
  const entryPrice =
    request.entryPrice !== null
      ? fp.parse(request.entryPrice)
      : adopted !== null
        ? fp.parse(adopted.entryPrice)
        : market.bestBid;
  const entrySource =
    request.entryPrice !== null
      ? "as you stated it"
      : adopted !== null
        ? `from the position you took over via ${adopted.source}`
        : "the current bid, which is only right for a position just opened";

  const problems = validateMandate({
    ladder: request.ladder,
    stopLossBps: request.stopLossBps,
    trailing: request.trailing,
    breakevenAtBps: request.breakevenAtBps,
    quantity,
    entryPrice,
    maxBps: deps.maxLegBps,
  });
  if (problems.length > 0) {
    return fail(
      refuse("AMOUNT_NOT_UNDERSTOOD", `That plan will not work:\n  - ${problems.join("\n  - ")}`).error,
    );
  }

  const mandate: ExitMandate = {
    id: `plan-${randomUUID()}` as MandateId,
    senderIdHash: deps.ownerHash,
    symbol,
    entryPrice,
    quantity,
    ladder: [...request.ladder].sort((a, b) => a.atBps - b.atBps),
    stopLossBps: request.stopLossBps,
    trailing: request.trailing,
    breakevenAtBps: request.breakevenAtBps,
    highWaterBps: 0,
    soldBps: 0,
    soldQuantity: fp.parse("0"),
    createdAt: now,
    expiresAt: addSeconds(now, (request.holdDays * 86_400) as never),
    status: "pending",
    sourceProposalId: null,
  };

  // The code is bound to a digest of the plan, so a plan whose numbers changed
  // cannot be armed by a code issued for the old ones.
  const planHash = deps.hash(
    [
      "kertel.plan.v1",
      mandate.symbol,
      fp.format(mandate.entryPrice),
      fp.format(mandate.quantity),
      JSON.stringify(mandate.ladder),
      String(mandate.stopLossBps),
      JSON.stringify(mandate.trailing),
      String(mandate.breakevenAtBps),
      String(mandate.expiresAt),
    ].join("\n"),
  );
  const code = makeCode(deps.random);
  const codeHash = hashConfirmationCode({ code, proposalHash: planHash, hash: deps.hash });

  deps.store.mandates.save(mandate, null, null, codeHash);

  return {
    ok: true,
    refusalCode: null,
    body: renderPlan(
      mandate,
      filters.baseAsset,
      filters.quoteAsset,
      market.bestBid,
      code,
      deps.mode,
      deps.store.mandates.lessonsFor(symbol).slice(0, 3).map((lesson) => lesson.text),
      entrySource,
    ),
  };
}

function renderPlan(
  mandate: ExitMandate,
  baseAsset: string,
  quoteAsset: string,
  bid: FixedPoint,
  code: string,
  mode: "fixture" | "live",
  lessons: readonly string[],
  entrySource: string,
): string {
  const lines: string[] = [];
  lines.push(`Exit plan: ${mandate.symbol}`);
  if (mode === "fixture") {
    lines.push("FIXTURE MODE - nothing will be sent to the exchange.");
  }
  lines.push("");
  lines.push(`Position:   ${fp.format(mandate.quantity)} ${baseAsset}`);
  lines.push(`Entry:      ${fp.format(mandate.entryPrice)} ${quoteAsset}  (${entrySource})`);
  lines.push(`Now:        ${fp.format(bid)} ${quoteAsset}`);
  lines.push("");

  if (mandate.ladder.length > 0) {
    lines.push("Take profit:");
    for (const rung of mandate.ladder) {
      const at = priceAtBps(mandate.entryPrice, rung.atBps);
      const size = fp.divide(
        fp.multiply(mandate.quantity, fp.parse(String(rung.fractionBps))),
        fp.parse("10000"),
        mandate.quantity.scale,
        "floor",
      );
      lines.push(
        `  sell ${fp.format(size)} ${baseAsset} at ${fp.format(at)}  (+${String(rung.atBps / 100)}%, ${String(rung.fractionBps / 100)}% of the position)`,
      );
    }
    lines.push("");
  }

  lines.push("Protection:");
  if (mandate.stopLossBps !== null) {
    lines.push(
      `  stop at ${fp.format(priceAtBps(mandate.entryPrice, -mandate.stopLossBps))}  (-${String(mandate.stopLossBps / 100)}%)`,
    );
  }
  if (mandate.breakevenAtBps !== null) {
    lines.push(
      `  once up ${String(mandate.breakevenAtBps / 100)}%, the stop moves to ${fp.format(mandate.entryPrice)} and the trade cannot lose`,
    );
  }
  if (mandate.trailing !== null) {
    lines.push(
      `  once up ${String(mandate.trailing.activateAtBps / 100)}%, a stop follows ${String(mandate.trailing.trailBps / 100)}% behind the peak`,
    );
  }
  if (mandate.stopLossBps === null && mandate.breakevenAtBps === null && mandate.trailing === null) {
    lines.push("  none — this position has no downside protection");
  }
  lines.push("");

  if (lessons.length > 0) {
    // Shown here on purpose. A lesson filed in a report nobody opens is a
    // lesson nobody applies; this is the moment it is about to matter again.
    lines.push("From what happened last time:");
    for (const lesson of lessons) {
      lines.push(`  - ${lesson}`);
    }
    lines.push("");
  }

  lines.push(`Expires:    ${formatInstant(mandate.expiresAt)}`);
  lines.push("");
  lines.push(`Reply  arm ${code}  to hand Kertel this position.`);
  lines.push("Once armed it acts on its own, inside these rules, without asking again.");
  return lines.join("\n");
}

/** Arm a drafted plan. From here the monitor owns the position. */
export function armPlan(deps: PlanDeps, code: string): PlanOutcome {
  const now = deps.now();
  const normalized = normalizeConfirmationCode(code);
  if (normalized === null) {
    return fail(refuse("TOKEN_NOT_FOUND", `${JSON.stringify(code)} is not a Kertel code.`).error);
  }

  // Every pending plan is tried, because the code is bound to the plan's own
  // digest and only one can match.
  for (const mandate of deps.store.mandates.all()) {
    if (mandate.status !== "pending") {
      continue;
    }
    const planHash = deps.hash(
      [
        "kertel.plan.v1",
        mandate.symbol,
        fp.format(mandate.entryPrice),
        fp.format(mandate.quantity),
        JSON.stringify(mandate.ladder),
        String(mandate.stopLossBps),
        JSON.stringify(mandate.trailing),
        String(mandate.breakevenAtBps),
        String(mandate.expiresAt),
      ].join("\n"),
    );
    const candidate = hashConfirmationCode({ code: normalized, proposalHash: planHash, hash: deps.hash });
    const armed = deps.store.mandates.activate(candidate);
    if (armed !== null) {
      deps.store.mandates.journal({
        at: now,
        kind: "mandate_created",
        symbol: armed.symbol,
        mandateId: armed.id,
        headline: `Now managing ${fp.format(armed.quantity)} ${armed.symbol}`,
        detail: describePlan(armed),
        evidence: null,
      });
      return {
        ok: true,
        refusalCode: null,
        body: [
          `Armed. Kertel is now managing ${fp.format(armed.quantity)} ${armed.symbol}.`,
          "",
          describePlan(armed),
          "",
          "It will act on these rules on its own. Use kertel_positions to see where it stands,",
          "kertel_journal to see what it has done, and kertel_stop to halt everything.",
        ].join("\n"),
      };
    }
  }

  return fail(
    refuse("TOKEN_NOT_FOUND", "That code does not match any plan waiting to be armed.").error,
  );
}

export function describePlan(mandate: ExitMandate): string {
  const parts: string[] = [];
  for (const rung of mandate.ladder) {
    parts.push(`${String(rung.fractionBps / 100)}% at +${String(rung.atBps / 100)}%`);
  }
  if (mandate.stopLossBps !== null) {
    parts.push(`stop -${String(mandate.stopLossBps / 100)}%`);
  }
  if (mandate.breakevenAtBps !== null) {
    parts.push(`breakeven once +${String(mandate.breakevenAtBps / 100)}%`);
  }
  if (mandate.trailing !== null) {
    parts.push(
      `trail ${String(mandate.trailing.trailBps / 100)}% once +${String(mandate.trailing.activateAtBps / 100)}%`,
    );
  }
  return parts.join(", ");
}

/** Where every plan currently stands. */
export function describePositions(deps: PlanDeps): string {
  const mandates = deps.store.mandates.all();
  if (mandates.length === 0) {
    return "No exit plans. Use kertel_plan_exit to hand Kertel a position to manage.";
  }

  const lines: string[] = ["Positions Kertel is managing", ""];
  for (const mandate of mandates) {
    const stop = effectiveStopBps(mandate);
    lines.push(`${mandate.symbol}  [${mandate.status}]  ${mandate.id}`);
    lines.push(`  ${fp.format(mandate.quantity)} from ${fp.format(mandate.entryPrice)}`);
    lines.push(`  plan: ${describePlan(mandate)}`);
    lines.push(
      `  peak +${String(mandate.highWaterBps / 100)}%, sold ${String(mandate.soldBps / 100)}%${
        stop === null ? "" : `, stop now at ${stop >= 0 ? "+" : ""}${String(stop / 100)}% (${fp.format(priceAtBps(mandate.entryPrice, stop))})`
      }`,
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function cancelPlan(deps: PlanDeps, id: string): PlanOutcome {
  const mandate = deps.store.mandates.find(id);
  if (mandate === null) {
    return fail(refuse("TOKEN_NOT_FOUND", `No plan with id ${id}.`).error);
  }
  if (mandate.status === "completed" || mandate.status === "cancelled") {
    return { ok: true, refusalCode: null, body: `That plan is already ${mandate.status}.` };
  }
  deps.store.mandates.setStatus(mandate.id, "cancelled");
  deps.store.mandates.journal({
    at: deps.now(),
    kind: "mandate_cancelled",
    symbol: mandate.symbol,
    mandateId: mandate.id,
    headline: `Stopped managing ${mandate.symbol}`,
    detail: "Cancelled by the owner.",
    evidence: null,
  });
  return {
    ok: true,
    refusalCode: null,
    body: `Cancelled. Kertel is no longer managing ${mandate.symbol}; the position is yours again.`,
  };
}

/** The activity log: what the agent did, and why. */
export function describeJournal(deps: PlanDeps, limit: number, withEvidence: boolean): string {
  const entries = deps.store.mandates.recentJournal(limit);
  if (entries.length === 0) {
    return "Nothing in the journal yet.";
  }

  const lines: string[] = ["What Kertel has been doing", ""];
  for (const entry of entries) {
    lines.push(`${formatInstant(entry.at)}  ${entry.headline}`);
    lines.push(`  ${entry.detail}`);
    if (withEvidence && entry.evidence !== null) {
      for (const line of entry.evidence.split("\n")) {
        lines.push(`  | ${line}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
