/** Protection monitoring and its human-readable memory. */

import { formatInstant } from "@telt/core/domain";
import type { Instant } from "@telt/core/domain";

import type { FuturesOutcome } from "./futures-trading.js";
import type { Store } from "./infra/store.js";

export type ProtectionDeps = {
  readonly store: Store;
  readonly now: () => Instant;
  readonly status: (symbol: string) => Promise<FuturesOutcome>;
  readonly research: (
    symbol: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly body: string;
    readonly spent: string;
    readonly refusalCode: string | null;
  }>;
};

/**
 * Check account facts first. Paid evidence is optional context and can never
 * delay or veto a protective action.
 */
export async function checkProtection(
  deps: ProtectionDeps,
  input: { readonly symbol: string; readonly investigate: boolean },
): Promise<FuturesOutcome> {
  const symbol = input.symbol.trim().toUpperCase();
  const status = await deps.status(symbol);
  if (!status.ok) return status;

  deps.store.mandates.journal({
    at: deps.now(),
    kind: "hedge_checked",
    symbol,
    mandateId: null,
    headline: `Checked ${symbol} protection`,
    detail: status.body.replace(/\s+/g, " ").trim(),
    evidence: null,
  });

  if (!input.investigate) {
    return {
      ok: true,
      refusalCode: null,
      body: `${status.body}\n\nPaid research: not used. Ask Telt to investigate the position when you want outside market context.`,
    };
  }

  const hasPairedHedge =
    /protection: (FULLY HEDGED|PARTIALLY HEDGED|OVERHEDGED)/.test(status.body);
  if (!hasPairedHedge) {
    return {
      ok: true,
      refusalCode: null,
      body: `${status.body}\n\nPaid research: not used. This account does not currently have a paired Spot hedge for ${symbol}.`,
    };
  }

  const evidence = await deps.research(symbol);
  deps.store.mandates.journal({
    at: deps.now(),
    kind: "hedge_researched",
    symbol,
    mandateId: null,
    headline: evidence.ok
      ? `Investigated ${symbol} while protection was active`
      : `Research coverage for ${symbol} was limited`,
    detail: `Paid research spent ${evidence.spent} USDC. ${
      evidence.ok
        ? "The evidence was attached as context; it did not change the hedge automatically."
        : `The protection check still completed${evidence.refusalCode === null ? "." : `; research returned ${evidence.refusalCode}.`}`
    }`,
    evidence: evidence.body,
  });

  return {
    ok: true,
    refusalCode: null,
    body: [
      status.body,
      "",
      "Paid investigation",
      evidence.body,
      "",
      "The research explains market context. It did not open, resize, or close the hedge.",
    ].join("\n"),
  };
}

/** A compact lifecycle, oldest first, suitable for display or Agent Memory. */
export function memoryLane(
  store: Store,
  input: { readonly symbol?: string; readonly limit: number },
): string {
  const symbol = input.symbol?.trim().toUpperCase() ?? null;
  const entries = store.mandates
    .recentJournal(500)
    .filter((entry) => entry.kind.startsWith("hedge_"))
    .filter((entry) => symbol === null || entry.symbol === symbol)
    .slice(0, input.limit)
    .reverse();

  if (entries.length === 0) {
    return symbol === null
      ? "Memory Lane is empty. Telt has not recorded a protection event yet."
      : `Memory Lane has no protection events for ${symbol} yet.`;
  }

  const lines = [
    symbol === null ? "Telt Memory Lane" : `${symbol} Memory Lane`,
    "",
  ];
  for (const entry of entries) {
    lines.push(`${formatInstant(entry.at)}  ${entry.headline}`);
    lines.push(`  ${entry.detail}`);
    lines.push("");
  }
  lines.push(
    "This timeline records what Telt observed and did. Paid evidence remains available in the journal receipt.",
  );
  return lines.join("\n").trimEnd();
}
