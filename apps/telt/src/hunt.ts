/**
 * Looking for something to trade, and acting on it, with nobody watching.
 *
 * This is the loop everything else in Telt exists to make safe. It scans the
 * venue, picks one candidate, pays for evidence about it, asks a model what the
 * evidence supports, and — if the answer is confident, well-formed and there is
 * budget — opens a position and arms an exit for it before saying anything to
 * anybody.
 *
 * The order of operations is the whole design, and each step is placed where it
 * is because of what it can prevent:
 *
 * 1. **Budget first, before spending a cent on research.** Researching a trade
 *    that could never have been afforded is the agent wasting your money to
 *    reach a conclusion it cannot use.
 * 2. **One candidate per run.** A loop that considers ten and buys the best is
 *    a loop that buys something every time it runs. Taking one and being
 *    willing to reject it means most runs correctly end in nothing.
 * 3. **Skip what is already held or already looked at.** Averaging into a
 *    position nobody planned, and re-buying research on the same token every
 *    thirty minutes, are the two ways this becomes expensive.
 * 4. **Evidence, then verdict, then budget again.** The second budget check
 *    matters: research takes time, and another hunt or a human trade may have
 *    spent it in between.
 * 5. **The exit plan is armed in the same run as the entry.** An autonomous
 *    entry without one is an unattended position, which is strictly worse than
 *    not trading. If the plan cannot be armed, the position is closed again
 *    immediately rather than left.
 *
 * What it never does: average into an existing position, exceed the per-idea
 * cap, act on a verdict below the confidence floor, or act at all when the kill
 * switch is engaged or an order is unreconciled.
 */

import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import { formatInstant } from "@telt/core/domain";
import type { Instant, Symbol_ } from "@telt/core/domain";
import { actionable, amountAtRisk, evaluateSpend, remaining } from "@telt/core/autonomy";
import type { DiscretionaryBudget, Verdict } from "@telt/core/autonomy";
import { rankMovers } from "@telt/core/research";
import { hasPaidCoverage } from "@telt/providers";
import type { Mover } from "@telt/core/research";

import type { BinanceClient } from "./infra/binance.js";
import type { ModelClient } from "./infra/model.js";
import type { Store } from "./infra/store.js";
import type { Logger } from "./infra/logger.js";

export type HuntDeps = {
  readonly store: Store;
  readonly binance: BinanceClient;
  readonly model: ModelClient;
  readonly log: Logger;
  readonly now: () => Instant;
  /** Free venue read, then paid evidence. Returns the receipt body. */
  readonly research: (
    symbol: string,
    goal: "price_check" | "trade_thesis",
  ) => Promise<{ readonly ok: boolean; readonly body: string; readonly spent: string }>;
  /** Opens a position without a confirmation code. Only this loop may call it. */
  readonly openDiscretionary: (input: {
    readonly symbol: Symbol_;
    readonly notional: FixedPoint;
  }) => Promise<{ readonly ok: boolean; readonly body: string; readonly orderRef: string | null }>;
  /** Arms a scale-out and stop for what was just opened. */
  readonly protect: (input: {
    readonly symbol: Symbol_;
  }) => Promise<{ readonly ok: boolean; readonly body: string }>;
  /**
   * Closes it again when protection could not be armed.
   *
   * Takes the size back, because this runs on the one path where leaving the
   * position is the worst outcome available and a sell that quietly does
   * nothing would look identical to a sell that worked.
   */
  readonly unwind: (symbol: Symbol_, notional: FixedPoint) => Promise<boolean>;
  readonly minQuoteVolume: FixedPoint;
};

export type HuntOutcome = {
  readonly acted: boolean;
  readonly body: string;
};

/**
 * How long before Telt looks at the same symbol again.
 *
 * Long enough that a hunt every half hour does not re-buy the same evidence
 * twelve times a day; short enough that a token which genuinely changed gets
 * reconsidered the same session.
 */
const RECONSIDER_AFTER_MS = 6 * 60 * 60 * 1000;

/** Below this, a percentage move is a handful of trades rather than a market. */
const DEFAULT_MIN_VOLUME = "5000000";

function note(deps: HuntDeps, symbol: string | null, headline: string, detail: string): void {
  deps.store.mandates.journal({
    at: deps.now(),
    kind: "checked",
    symbol: symbol ?? "-",
    mandateId: null,
    headline,
    detail,
    evidence: null,
  });
}

export async function hunt(deps: HuntDeps): Promise<HuntOutcome> {
  const now = deps.now();

  // --- 1. May Telt act at all? ------------------------------------------
  const safety = deps.store.safetyState();
  if (safety.killSwitchEngaged) {
    return {
      acted: false,
      body: `Telt is stopped: ${safety.killSwitchReason ?? "no reason recorded"}. It did not hunt.`,
    };
  }
  if (safety.unreconciledOperations.length > 0) {
    return {
      acted: false,
      body: "An earlier order is unresolved, so Telt did not hunt. Exposure it cannot see is exposure it cannot bound.",
    };
  }

  const budget = deps.store.autonomy.current();
  const left = budget === null ? fp.parse("0.00") : remaining(budget);

  // Checked before a cent of research is spent. Researching a trade that could
  // never have been afforded is spending your money to reach a conclusion Telt
  // cannot use.
  const gate = evaluateSpend(budget, fp.parse("0.01"), now);
  if (gate.kind === "refused") {
    return { acted: false, body: gate.because };
  }
  if (!deps.model.available) {
    return {
      acted: false,
      body: "Telt has no reasoning layer of its own (no ANTHROPIC_API_KEY), so it will not open a position unattended.",
    };
  }

  // --- 2. One candidate -------------------------------------------------
  const movers = await deps.binance.movers();
  if (!movers.ok) {
    return { acted: false, body: `Telt could not read the venue: ${movers.error.detail}` };
  }

  const ranked = rankMovers(movers.value, {
    quoteAsset: "USDT",
    minQuoteVolume: deps.minQuoteVolume,
    limit: 10,
  });

  const { candidate, skippedUncovered } = pickCandidate(deps, ranked.gainers, now);
  if (candidate === null) {
    const why =
      skippedUncovered > 0
        ? `${String(skippedUncovered)} of the movers have no verified provider id, so the only price available for them is Binance's own. Telt will not act on one uncorroborated source.`
        : "Everything moving is either already held or was looked at recently.";
    note(deps, null, "Looked and found nothing", why);
    return {
      acted: false,
      body: `Looked at ${String(ranked.liquid)} liquid pairs and did not act.

  ${why}`,
    };
  }

  // --- 3. Buy the evidence ---------------------------------------------
  deps.store.autonomy.recordLook(candidate.symbol, now);
  const evidence = await deps.research(candidate.symbol, "trade_thesis");
  if (!evidence.ok) {
    note(deps, candidate.symbol, `Could not research ${candidate.symbol}`, evidence.body.slice(0, 400));
    return { acted: false, body: `Telt looked at ${candidate.symbol} and could not get usable evidence. It did not act.` };
  }

  // --- 4. What does it support? ----------------------------------------
  // What the model is shown is the facts, and only the facts.
  //
  // Telt's receipt is written for a person: it explains why each source was
  // worth buying and frames the ones it skipped as money saved. That is useful
  // to a reader deciding whether to trust the agent, and it is steering to one
  // being asked to judge impartially — the model flagged it twice, once as an
  // attestation "trying to lend false authority to a no-data decision" and once
  // as "framing language that could be seen as trying to steer interpretation
  // toward action". Both were fair.
  //
  // So the proof block goes, the rationale goes, and the savings go. What
  // survives is the sources, their values, and any warning about what could not
  // be read — which is the part a decision should actually rest on.
  const forModel = evidenceOnly(evidence.body);

  const judged = await deps.model.judge({ symbol: candidate.symbol, evidence: forModel });
  if (!judged.ok) {
    note(deps, candidate.symbol, `No verdict on ${candidate.symbol}`, judged.error.detail);
    return { acted: false, body: `${candidate.symbol}: ${judged.error.detail}` };
  }

  const verdict = judged.value;
  const decision = actionable(verdict);
  deps.store.autonomy.recordVerdict({
    symbol: candidate.symbol,
    at: now,
    action: verdict.action,
    confidence: verdict.confidence,
    because: verdict.because,
    acted: false,
  });

  if (!decision.act) {
    // The missed-opportunity record. What Telt saw and declined is worth as
    // much afterwards as what it bought, and no other agent writes it down.
    note(
      deps,
      candidate.symbol,
      `Passed on ${candidate.symbol}`,
      `${decision.because} ${verdict.because}`,
    );
    return {
      acted: false,
      body: renderPass(candidate, verdict, decision.because, evidence.spent, left),
    };
  }

  // --- 5. Budget again, then act ---------------------------------------
  const size = sizeFor(budget, candidate);
  const approved = evaluateSpend(deps.store.autonomy.current(), size, deps.now());
  if (approved.kind === "refused") {
    note(deps, candidate.symbol, `Could not fund ${candidate.symbol}`, approved.because);
    return { acted: false, body: `${candidate.symbol} was worth buying and Telt could not fund it: ${approved.because}` };
  }

  const opened = await deps.openDiscretionary({ symbol: candidate.symbol, notional: size });
  if (!opened.ok) {
    note(deps, candidate.symbol, `Entry refused on ${candidate.symbol}`, opened.body.slice(0, 400));
    return { acted: false, body: `${candidate.symbol}: ${opened.body}` };
  }

  deps.store.autonomy.commitSpend(
    amountAtRisk({ market: "spot", notional: size, leverage: 1 }),
    candidate.symbol,
    opened.orderRef,
    deps.now(),
  );

  // --- 6. Protect it, in the same run ----------------------------------
  const protection = await deps.protect({ symbol: candidate.symbol });
  if (!protection.ok) {
    // An unattended position with no exit is worse than no position. Unwind
    // rather than leave it and hope somebody notices in the morning.
    deps.log.error("could not protect an autonomous entry, unwinding", {
      symbol: candidate.symbol,
      problem: protection.body.slice(0, 200),
    });
    const closed = await deps.unwind(candidate.symbol, size);
    if (!closed) {
      // The genuinely bad case: open, unprotected, and it would not close.
      // Stop everything and say so at the top of the message, rather than
      // carry on hunting with a position nobody is watching.
      deps.store.engageKillSwitch(
        `an autonomous ${candidate.symbol} entry could not be protected and could not be closed`,
        deps.now(),
      );
      return {
        acted: true,
        body: `URGENT: Telt opened ${candidate.symbol}, could not arm an exit plan, and could not close it again. The position is OPEN AND UNPROTECTED. Telt has stopped itself and will not trade again until you resolve it.\n\n${protection.body}`,
      };
    }
    return {
      acted: false,
      body: `Telt opened ${candidate.symbol}, could not arm an exit plan for it, and closed it again. An unattended position with no exit is worse than no position.\n\n${protection.body}`,
    };
  }

  deps.store.autonomy.recordVerdict({
    symbol: candidate.symbol,
    at: deps.now(),
    action: verdict.action,
    confidence: verdict.confidence,
    because: verdict.because,
    acted: true,
  });

  return {
    acted: true,
    body: renderActed(candidate, verdict, size, opened, protection, evidence.spent, deps.now()),
  };
}

type Candidate = { readonly symbol: Symbol_; readonly changeBps: number; readonly volume: FixedPoint };

/**
 * The one to look at, or nothing.
 *
 * Skips anything already held, because averaging into a position nobody planned
 * is how an agent quietly concentrates a portfolio, and anything looked at
 * recently, because re-buying the same evidence every half hour is how it
 * quietly spends a research budget.
 */
function pickCandidate(
  deps: HuntDeps,
  gainers: readonly Mover[],
  now: Instant,
): { readonly candidate: Candidate | null; readonly skippedUncovered: number } {
  const managed = new Set(deps.store.mandates.active().map((mandate) => mandate.symbol as string));
  let skippedUncovered = 0;

  for (const mover of gainers) {
    if (managed.has(mover.symbol as string)) continue;

    const lastLooked = deps.store.autonomy.lastLooked(mover.symbol);
    if (lastLooked !== null && now - lastLooked < RECONSIDER_AFTER_MS) continue;

    // No paid provider has a verified id for this, so the only price available
    // is the venue's own. A single uncorroborated source can never clear the
    // confidence floor -- the reasoning layer will say so, correctly, every
    // time -- so looking is a guaranteed no with an API call attached.
    //
    // This is also the honest signal about where Telt's limit actually is: not
    // the reasoning, the coverage.
    if (!hasPaidCoverage(mover.symbol)) {
      skippedUncovered += 1;
      continue;
    }

    return {
      candidate: { symbol: mover.symbol, changeBps: mover.changeBps, volume: mover.quoteVolume },
      skippedUncovered,
    };
  }
  return { candidate: null, skippedUncovered };
}

/** The whole per-idea cap, or what is left if that is less. */
function sizeFor(budget: DiscretionaryBudget | null, _candidate: Candidate): FixedPoint {
  if (budget === null) return fp.parse("0.00");
  const left = remaining(budget);
  return fp.greaterThan(budget.perTradeCap, left) ? left : budget.perTradeCap;
}

function renderPass(
  candidate: Candidate,
  verdict: Verdict,
  why: string,
  spent: string,
  left: FixedPoint,
): string {
  const lines = [`Looked at ${candidate.symbol}, did not act`, ""];
  lines.push(`  Moving:     ${(candidate.changeBps / 100).toFixed(1)}% over 24h`);
  lines.push(`  Verdict:    ${verdict.action} at ${String(Math.round(verdict.confidence))}`);
  lines.push(`  Because:    ${verdict.because}`);
  if (verdict.risks.length > 0) {
    lines.push(`  Risks:      ${verdict.risks.join("; ")}`);
  }
  lines.push("");
  lines.push(`  ${why}`);
  lines.push(`  Research cost ${spent}. Budget untouched, ${fp.format(left)} still available.`);
  return lines.join("\n");
}

function renderActed(
  candidate: Candidate,
  verdict: Verdict,
  size: FixedPoint,
  opened: { readonly body: string; readonly orderRef: string | null },
  protection: { readonly body: string },
  spent: string,
  now: Instant,
): string {
  const lines = [`Telt opened ${candidate.symbol} on its own`, ""];
  lines.push(`  Size:       ${fp.format(size)} USDT`);
  lines.push(`  Moving:     ${(candidate.changeBps / 100).toFixed(1)}% over 24h`);
  lines.push(`  Confidence: ${String(Math.round(verdict.confidence))}`);
  lines.push(`  Because:    ${verdict.because}`);
  lines.push(`  Risks:      ${verdict.risks.join("; ")}`);
  lines.push(`  Research:   ${spent}`);
  if (opened.orderRef !== null) lines.push(`  Order:      ${opened.orderRef}`);
  lines.push("");
  lines.push("It is already protected:");
  lines.push(protection.body);
  lines.push("");
  lines.push(formatInstant(now));
  return lines.join("\n");
}

export { DEFAULT_MIN_VOLUME };

/**
 * Strip a receipt down to what was actually read.
 *
 * Keeps the sources and their values, and keeps every warning, because "this
 * could not be corroborated" is evidence of the most important kind. Drops the
 * proof block, the per-source rationale and the not-read accounting, all of
 * which exist to explain Telt's behaviour to a person rather than to describe
 * the asset.
 */
function evidenceOnly(receipt: string): string {
  const lines = receipt.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Sections that are about Telt rather than about the token.
    if (
      trimmed.startsWith("Not read:") ||
      trimmed.startsWith("Proof of research") ||
      trimmed.startsWith("Not spent:") ||
      trimmed.startsWith("Verify with") ||
      trimmed.startsWith("TELT-ATTESTATION-1")
    ) {
      skipping = true;
      continue;
    }
    // A blank line ends a skipped section, unless the attestation has begun —
    // that block runs to the end.
    if (skipping) {
      if (trimmed === "" && !kept.some((k) => k.includes("TELT-ATTESTATION"))) {
        skipping = false;
      }
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n").trim();
}
