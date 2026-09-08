/**
 * Opening and closing futures positions, under the same discipline as spot.
 *
 * The confirmation spine does not change: a position is priced, shown with the
 * numbers that will actually be sent, and opened only against a one-use code.
 * What changes is what has to be checked before the code is issued, because
 * futures can lose more than it cost.
 *
 * Four gates exist here that spot does not need:
 *
 * 1. **Isolated margin, always.** Binance ships ETHUSDT at cross, where the
 *    entire futures wallet backs the position. Telt sets isolated first and
 *    refuses if it could not, rather than opening into cross and hoping.
 * 2. **A leverage ceiling.** The exchange default is 20x. At 20x a 5% move is
 *    the whole margin. Telt caps it, and the cap is configuration rather than
 *    something the model can talk it out of.
 * 3. **A separate notional cap.** Leverage means a small margin controls a large
 *    position, so the spot per-trade cap does not bound the risk. Futures gets
 *    its own ceiling on the *position*, not the margin.
 * 4. **Liquidation distance is shown before you agree.** The proposal states
 *    where the exchange would close the position for you. A plan that cannot
 *    survive a normal day's range is one you should see as such before typing
 *    a code, not afterwards.
 */


import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import { formatInstant, refuse } from "@telt/core/domain";
import type { Instant, Refusal, SenderIdHash, Symbol_ } from "@telt/core/domain";
import {
  generateConfirmationCode,
  hashConfirmationCode,
  normalizeConfirmationCode,
} from "@telt/core/confirmation";

import { clientOrderIdFrom } from "./infra/binance.js";
import {
  describePosition,
  isFlat,
  liquidationDistanceBps,
  positionSide,
} from "./infra/futures.js";
import type { FuturesClient, FuturesPosition } from "./infra/futures.js";
import type { Store } from "./infra/store.js";

export type FuturesDeps = {
  readonly futures: FuturesClient;
  readonly store: Store;
  readonly hash: (input: string) => string;
  readonly random: (count: number) => Uint8Array;
  readonly now: () => Instant;
  readonly ownerHash: SenderIdHash | null;
  readonly mode: "fixture" | "live";
  readonly liveExecutionEnabled: boolean;
  readonly maxLeverage: number;
  readonly maxNotional: FixedPoint;
  readonly newId: (prefix: string) => string;
};

export type FuturesOutcome = {
  readonly ok: boolean;
  readonly body: string;
  readonly refusalCode: string | null;
};

function fail(refusal: Refusal): FuturesOutcome {
  return { ok: false, refusalCode: refusal.code, body: refusal.detail };
}

/**
 * A move this size in a day is ordinary for a liquid pair.
 *
 * Used to judge whether a liquidation price is close enough to be worth calling
 * out. It is a warning threshold, not a limit.
 */
const ORDINARY_DAILY_RANGE_BPS = 500;

type PendingFutures = {
  readonly id: string;
  readonly symbol: Symbol_;
  readonly side: "BUY" | "SELL";
  readonly quantity: FixedPoint;
  readonly notional: FixedPoint;
  readonly leverage: number;
  readonly markPrice: FixedPoint;
  readonly codeHash: string;
  readonly expiresAt: Instant;
};

/** In memory on purpose: a futures proposal that outlives a restart is a stale price. */
const pending = new Map<string, PendingFutures>();

export async function proposeFutures(
  deps: FuturesDeps,
  input: {
    readonly symbol: string;
    readonly side: "BUY" | "SELL";
    readonly notional: string;
    readonly leverage: number;
  },
): Promise<FuturesOutcome> {
  const now = deps.now();
  const symbol = input.symbol.trim().toUpperCase() as Symbol_;

  if (deps.ownerHash === null) {
    return fail(refuse("SENDER_NOT_ALLOWED", "Telt has no configured owner.").error);
  }

  const safety = deps.store.safetyState();
  if (safety.killSwitchEngaged) {
    return fail(
      refuse("KILL_SWITCH_ENGAGED", `Telt is stopped: ${safety.killSwitchReason ?? "no reason recorded"}.`)
        .error,
    );
  }
  if (safety.unreconciledOperations.length > 0) {
    return fail(
      refuse(
        "PENDING_OPERATION_UNRECONCILED",
        "An earlier order is still unresolved. Reconcile it before opening a position.",
      ).error,
    );
  }

  if (!Number.isInteger(input.leverage) || input.leverage < 1) {
    return fail(refuse("AMOUNT_NOT_UNDERSTOOD", "Leverage must be a whole number of at least 1.").error);
  }
  if (input.leverage > deps.maxLeverage) {
    return fail(
      refuse(
        "NOTIONAL_ABOVE_CAP",
        `${String(input.leverage)}x is above the ${String(deps.maxLeverage)}x ceiling. At high leverage an ordinary day's move is the whole margin.`,
        { requested: input.leverage, cap: deps.maxLeverage },
      ).error,
    );
  }
  if (!/^\d+(\.\d+)?$/.test(input.notional.trim())) {
    return fail(
      refuse("AMOUNT_NOT_UNDERSTOOD", `Telt could not read ${JSON.stringify(input.notional)} as an amount.`)
        .error,
    );
  }

  const notional = fp.parse(input.notional.trim());
  if (fp.greaterThan(notional, deps.maxNotional)) {
    return fail(
      refuse(
        "NOTIONAL_ABOVE_CAP",
        `A ${fp.format(notional)} position is above your ${fp.format(deps.maxNotional)} futures cap. Leverage means a small margin controls a large position, so this cap is on the position, not what you put up.`,
      ).error,
    );
  }

  const [filtersResult, positionResult] = await Promise.all([
    deps.futures.filters(symbol),
    deps.futures.position(symbol),
  ]);
  if (!filtersResult.ok) return fail(filtersResult.error);
  if (!positionResult.ok) return fail(positionResult.error);

  const filters = filtersResult.value;
  const existing = positionResult.value;

  if (!isFlat(existing)) {
    return fail(
      refuse(
        "EXCHANGE_REJECTED",
        `There is already a ${positionSide(existing)} position in ${symbol}. Close it before opening another; Telt will not average into a position you did not plan.`,
      ).error,
    );
  }

  if (fp.lessThan(notional, filters.minNotional)) {
    return fail(
      refuse(
        "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
        `Binance requires at least ${fp.format(filters.minNotional)} of position on ${symbol} futures. That is on the position, not the margin: at ${String(input.leverage)}x it needs about ${fp.format(fp.divide(filters.minNotional, fp.parse(String(input.leverage)), 2, "ceil"))} of margin.`,
      ).error,
    );
  }

  // Read independently. A flat position reports a mark of zero, which is
  // exactly the state a first entry is sized from.
  const markResult = await deps.futures.markPrice(symbol);
  if (!markResult.ok) return fail(markResult.error);
  const mark = markResult.value;

  // Floored to the lot step, then the notional is recomputed from what survived,
  // so the number shown is the number sent.
  const rawQuantity = fp.divide(notional, mark, filters.stepSize.scale, "floor");
  const quantity = fp.floorToStep(rawQuantity, filters.stepSize);
  if (!fp.isPositive(quantity) || fp.lessThan(quantity, filters.minQuantity)) {
    return fail(
      refuse(
        "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
        `${fp.format(notional)} at ${fp.format(mark)} rounds down to less than the ${fp.format(filters.minQuantity)} minimum lot on ${symbol}.`,
      ).error,
    );
  }
  const actualNotional = fp.multiply(quantity, mark);

  // Check the minimum again, against what will actually be sent.
  //
  // The check above ran on the requested notional; this one runs on what
  // survived the lot step, and the two differ by up to one step. On ETHUSDT a
  // step is 0.001 ETH, worth about 2.50, so asking for 21 floors to 0.008 and
  // sends a 19.97 position into a 20.00 minimum. Binance answers -4164 and the
  // rejection arrives after the code was typed, which is the worst moment for
  // it. Refusing here names the amount that would work instead.
  if (fp.lessThan(actualNotional, filters.minNotional)) {
    const nextQuantity = fp.add(quantity, filters.stepSize);
    const nextNotional = fp.multiply(nextQuantity, mark);
    return fail(
      refuse(
        "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
        `${fp.format(notional)} floors to ${fp.format(quantity)} ${symbol.replace("USDT", "")} at ${fp.format(mark)}, which is a ${fp.format(fp.trim(actualNotional, 2))} position — under Binance's ${fp.format(filters.minNotional)} minimum. The lot step is ${fp.format(filters.stepSize)}, so the next size up is ${fp.format(nextQuantity)}: ask for ${fp.format(fp.trim(nextNotional, 2))} or more.`,
        { requested: fp.format(notional), wouldSend: fp.format(actualNotional) },
      ).error,
    );
  }

  const margin = fp.divide(actualNotional, fp.parse(String(input.leverage)), 2, "ceil");

  // Isolated first, then leverage. Both before a code is issued, so a user is
  // never shown a plan that could not have been set up.
  const isolated = await deps.futures.setIsolated(symbol);
  if (!isolated.ok) {
    return fail(isolated.error);
  }
  const levered = await deps.futures.setLeverage(symbol, input.leverage);
  if (!levered.ok) {
    return fail(levered.error);
  }

  // Read the position back so the liquidation price shown is the exchange's,
  // not one Telt estimated.
  const after = await deps.futures.position(symbol);
  const liquidationNote =
    after.ok && after.value.liquidationPrice !== null
      ? `${fp.format(after.value.liquidationPrice)}`
      : "not reported until the position is open";

  const id = deps.newId("fut");
  const code = generateConfirmationCode(deps.random);
  const planHash = deps.hash(
    [
      "telt.futures.v1",
      symbol,
      input.side,
      fp.format(quantity),
      String(input.leverage),
      fp.format(mark),
    ].join("\n"),
  );
  const codeHash = hashConfirmationCode({ code, proposalHash: planHash, hash: deps.hash });
  const expiresAt = (now + 120_000) as Instant;

  pending.set(codeHash, {
    id,
    symbol,
    side: input.side,
    quantity,
    notional: actualNotional,
    leverage: input.leverage,
    markPrice: mark,
    codeHash,
    expiresAt,
  });

  const lines: string[] = [];
  lines.push(`${input.side === "BUY" ? "LONG" : "SHORT"} ${symbol} futures`);
  if (deps.mode === "fixture") {
    lines.push("FIXTURE MODE - nothing will be sent to the exchange.");
  }
  lines.push("");
  lines.push(`Size:        ${fp.format(quantity)} (${fp.format(actualNotional)} notional)`);
  lines.push(`Leverage:    ${String(input.leverage)}x, isolated margin`);
  lines.push(`Margin:      about ${fp.format(margin)}`);
  lines.push(`Mark:        ${fp.format(mark)}`);
  lines.push("");
  lines.push(`Liquidation: ${liquidationNote}`);
  lines.push("");
  lines.push("Isolated margin means only this margin is at risk, not the whole");
  lines.push(`futures wallet. At ${String(input.leverage)}x a ${String(Math.round(10000 / input.leverage) / 100)}% move against you is the entire margin.`);
  lines.push("");
  lines.push(`Reply  confirm ${code}  to open it.`);
  lines.push(`The code works once, for this position only, until ${formatInstant(expiresAt)}.`);

  return { ok: true, refusalCode: null, body: lines.join("\n") };
}

export async function confirmFutures(deps: FuturesDeps, code: string): Promise<FuturesOutcome> {
  const now = deps.now();
  const normalized = normalizeConfirmationCode(code);
  if (normalized === null) {
    return fail(refuse("TOKEN_NOT_FOUND", `${JSON.stringify(code)} is not a Telt code.`).error);
  }

  for (const [codeHash, plan] of pending) {
    const planHash = deps.hash(
      [
        "telt.futures.v1",
        plan.symbol,
        plan.side,
        fp.format(plan.quantity),
        String(plan.leverage),
        fp.format(plan.markPrice),
      ].join("\n"),
    );
    if (hashConfirmationCode({ code: normalized, proposalHash: planHash, hash: deps.hash }) !== codeHash) {
      continue;
    }

    // Spent before anything is sent, so a code cannot survive a failed send.
    pending.delete(codeHash);

    if (now >= plan.expiresAt) {
      return fail(
        refuse("PROPOSAL_EXPIRED", "That position was priced more than two minutes ago. Ask again.")
          .error,
      );
    }

    if (deps.mode !== "live" || !deps.liveExecutionEnabled) {
      return fail(
        refuse(
          "LIVE_EXECUTION_DISABLED",
          `Everything checked out and Telt stopped at the live write gate. It would have opened ${plan.side === "BUY" ? "a long" : "a short"} of ${fp.format(plan.quantity)} ${plan.symbol} at ${String(plan.leverage)}x isolated.`,
        ).error,
      );
    }

    const clientOrderId = clientOrderIdFrom(deps.hash(`${plan.id}\n${codeHash}`));
    const placed = await deps.futures.open({
      symbol: plan.symbol,
      side: plan.side,
      quantity: plan.quantity,
      clientOrderId,
    });

    if (!placed.ok) {
      if (placed.error.code === "EXECUTION_RESULT_UNKNOWN") {
        deps.store.engageKillSwitch(
          `a futures order for ${plan.symbol} was sent and never confirmed; reconcile before trading again`,
          now,
        );
      }
      return fail(placed.error);
    }

    const fill = placed.value;
    const after = await deps.futures.position(plan.symbol);

    const lines = [
      `Opened ${plan.side === "BUY" ? "LONG" : "SHORT"} ${plan.symbol}: ${fill.status}`,
      "",
      `Filled:      ${fp.format(fill.filledQuantity)}${fill.averagePrice === null ? "" : ` at ${fp.format(fill.averagePrice)}`}`,
      `Order ref:   ${fill.orderRef}`,
    ];
    if (after.ok) {
      lines.push("");
      lines.push(describePosition(after.value));
      const distance = liquidationDistanceBps(after.value);
      if (distance !== null && distance <= ORDINARY_DAILY_RANGE_BPS) {
        lines.push("");
        lines.push(
          `WARNING: liquidation is only ${String(distance / 100)}% away, which is inside an ordinary day's range for most pairs.`,
        );
      }
    }
    lines.push("");
    lines.push("Telt is watching this position. Use telt_futures_close to exit,");
    lines.push("or telt_positions to see where it stands.");

    return { ok: true, refusalCode: null, body: lines.join("\n") };
  }

  return fail(refuse("TOKEN_NOT_FOUND", "That code does not match any position waiting to open.").error);
}

/**
 * Close a position, in full or in part.
 *
 * Closing needs no confirmation code. Getting *out* of a position is the safe
 * direction, and a code standing between a user and an exit is a code that
 * costs money in exactly the moment it matters.
 */
export async function closeFutures(
  deps: FuturesDeps,
  input: { readonly symbol: string; readonly fractionBps: number },
): Promise<FuturesOutcome> {
  const now = deps.now();
  const symbol = input.symbol.trim().toUpperCase() as Symbol_;

  const positionResult = await deps.futures.position(symbol);
  if (!positionResult.ok) return fail(positionResult.error);
  const position = positionResult.value;

  if (isFlat(position)) {
    return { ok: true, refusalCode: null, body: `There is no open ${symbol} futures position.` };
  }

  const held = fp.abs(position.positionAmt);
  const fraction = Math.max(1, Math.min(10_000, input.fractionBps));
  const filtersResult = await deps.futures.filters(symbol);
  if (!filtersResult.ok) return fail(filtersResult.error);

  let quantity =
    fraction >= 10_000
      ? held
      : fp.floorToStep(
          fp.divide(
            fp.multiply(held, fp.parse(String(fraction))),
            fp.parse("10000"),
            filtersResult.value.stepSize.scale,
            "floor",
          ),
          filtersResult.value.stepSize,
        );

  // Two ways a partial close goes wrong, and both end the same way: close the
  // lot. Stranding a remainder too small to close later leaves a position
  // nobody can ever exit, and a position already at the exchange minimum cannot
  // be halved at all. In the exit direction, doing the whole thing beats
  // refusing — but it is never done silently.
  let partialImpossible = false;
  const leftover = fp.subtract(held, quantity);
  if (fp.isPositive(leftover) && fp.lessThan(leftover, filtersResult.value.minQuantity)) {
    quantity = held;
    partialImpossible = true;
  }
  if (!fp.isPositive(quantity)) {
    quantity = held;
    partialImpossible = true;
  }
  if (fp.lessThan(quantity, filtersResult.value.minQuantity)) {
    return fail(
      refuse(
        "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
        `The whole ${symbol} position is ${fp.format(held)}, below the ${fp.format(filtersResult.value.minQuantity)} minimum lot, so the exchange will not accept an order to close it.`,
      ).error,
    );
  }

  if (deps.mode !== "live" || !deps.liveExecutionEnabled) {
    return fail(
      refuse(
        "LIVE_EXECUTION_DISABLED",
        `Telt would have closed ${fp.format(quantity)} of the ${positionSide(position)} ${symbol} position, but the live write gate is off.`,
      ).error,
    );
  }

  const clientOrderId = clientOrderIdFrom(
    deps.hash(`telt.futures.close\n${symbol}\n${fp.format(quantity)}\n${String(now)}`),
  );
  const closed = await deps.futures.close({ symbol, position, quantity, clientOrderId });
  if (!closed.ok) {
    if (closed.error.code === "EXECUTION_RESULT_UNKNOWN") {
      deps.store.engageKillSwitch(
        `a futures close for ${symbol} was sent and never confirmed; reconcile before trading again`,
        now,
      );
    }
    return fail(closed.error);
  }

  const fill = closed.value;
  const realised = position.unrealisedPnl;
  const note = partialImpossible && fraction < 10_000
    ? [
        "",
        `Closed all of it: ${String(fraction / 100)}% of this position is below the exchange's`,
        "minimum lot, so a partial close was not possible.",
      ]
    : [];
  return {
    ok: true,
    refusalCode: null,
    body: [
      `Closed ${fp.format(fill.filledQuantity)} of the ${positionSide(position)} ${symbol} position.`,
      "",
      `Fill:        ${fill.averagePrice === null ? "reported by the exchange" : fp.format(fill.averagePrice)}`,
      `Entry:       ${fp.format(position.entryPrice)}`,
      `Unrealised at close: ${fp.format(realised)}`,
      `Order ref:   ${fill.orderRef}`,
      ...note,
    ].join("\n"),
  };
}

/** Every open futures position, with the number that matters most. */
export async function describeFutures(
  deps: FuturesDeps,
  symbols: readonly string[],
): Promise<string> {
  const balances = await deps.futures.balances();
  const lines: string[] = ["Futures"];

  if (balances.ok) {
    const funded = balances.value.filter((entry) => fp.isPositive(entry.balance));
    lines.push(
      funded.length === 0
        ? "  wallet: empty"
        : // Binance answers with eight decimals on every asset. Trailing zeros
          // past the cents are the exchange's storage precision, not money, and
          // showing them reads as false precision on a balance.
          `  wallet: ${funded
            .map((entry) => `${fp.format(fp.trim(entry.balance, 2))} ${entry.asset}`)
            .join(", ")}`,
    );
  }
  lines.push("");

  let anyOpen = false;
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase() as Symbol_;
    const result = await deps.futures.position(symbol);
    if (!result.ok) {
      lines.push(`  ${symbol}: could not read (${result.error.code})`);
      continue;
    }
    if (isFlat(result.value)) {
      continue;
    }
    anyOpen = true;
    lines.push(describePosition(result.value));

    const distance = liquidationDistanceBps(result.value);
    if (distance !== null && distance <= ORDINARY_DAILY_RANGE_BPS) {
      lines.push(
        `  WARNING: liquidation is ${String(distance / 100)}% away, inside an ordinary day's range.`,
      );
    }
    if (!result.value.isolated) {
      lines.push("  WARNING: this position is on CROSS margin. The whole wallet backs it.");
    }
    lines.push("");
  }

  if (!anyOpen) {
    lines.push("  No open positions.");
  }
  return lines.join("\n").trimEnd();
}

export function pendingCount(): number {
  return pending.size;
}

export function clearPending(): void {
  pending.clear();
}

export type { FuturesPosition };
