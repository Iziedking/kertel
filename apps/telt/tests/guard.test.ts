import { describe, expect, it } from "vitest";
import { instant, ok } from "@telt/core/domain";
import type { Symbol_ } from "@telt/core/domain";
import * as fp from "@telt/core/money";
import { classifyGuard } from "../src/guard.js";
import { openStore } from "../src/infra/store.js";
import { loadConfig } from "../src/infra/config.js";
import { createLogger } from "../src/infra/logger.js";
import type { BinanceClient } from "../src/infra/binance.js";
import type { FuturesClient, FuturesPosition } from "../src/infra/futures.js";
import { createRuntime } from "../src/runtime.js";

const NOW = instant(Date.parse("2026-09-08T12:00:00.000Z"));
const q = (value: string) => fp.parse(value);

describe("Guard Mode", () => {
  it("distinguishes protected, drift and unprotected exposure", () => {
    const base = { targetCoverageBps: 10000, toleranceBps: 100, maxAgeMs: 30000, observedAt: NOW, now: NOW, marketAvailable: true };
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("1") }).state).toBe("protected");
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("0.8") }).state).toBe("underhedged");
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("1.2") }).state).toBe("overhedged");
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("0") }).state).toBe("unprotected");
    expect(classifyGuard({ ...base, spotQuantity: q("0"), futuresShortQuantity: q("0.3") }).state).toBe("overhedged");
    expect(classifyGuard({ ...base, spotQuantity: q("0"), futuresShortQuantity: q("0") }).state).toBe("protected");
  });

  it("fails closed on stale data", () => {
    const result = classifyGuard({ targetCoverageBps: 10000, toleranceBps: 100, maxAgeMs: 30000, spotQuantity: q("1"), futuresShortQuantity: q("1"), observedAt: instant(NOW - 31_000), now: NOW, marketAvailable: true });
    expect(result.state).toBe("unknown");
  });

  it("persists, checkpoints and revokes a mandate across store calls", () => {
    const store = openStore(":memory:");
    store.mandates.saveProtection({ id: "guard-1", symbol: "SOLUSDT", targetCoverageBps: 10000, toleranceBps: 150, maxNotional: "50", leverage: 2, maxAdjustmentBps: 2000, version: 1, createdAt: NOW, expiresAt: instant(NOW + 86_400_000), cooldownMs: 60_000, status: "active", lastActionAt: null, checkpointAt: NOW, lastState: "armed" });
    expect(store.mandates.activeProtection("SOLUSDT", NOW)?.id).toBe("guard-1");
    store.mandates.checkpointProtection("guard-1", { at: instant(NOW + 1000), state: "underhedged" });
    expect(store.mandates.activeProtection("SOLUSDT", NOW)?.lastState).toBe("underhedged");
    store.mandates.revokeProtection("guard-1", instant(NOW + 2000));
    expect(store.mandates.activeProtection("SOLUSDT", NOW)).toBeNull();
    store.close();
  });

  it("keeps an unfinished adjustment visible after restart", () => {
    const store = openStore(":memory:");
    expect(store.mandates.claimGuardOperation({
      id: "guard-op-1",
      mandateId: "guard-1",
      symbol: "SOLUSDT",
      idempotencyKey: "guard-key-1",
      clientOrderId: "guard-client-1",
      action: "increase",
      quantity: "0.3",
      status: "submitted",
      orderRef: null,
      filledQuantity: "0",
      createdAt: NOW,
      updatedAt: NOW,
    })).toBe(true);
    expect(store.mandates.unresolvedGuardOperations()).toHaveLength(1);
    store.mandates.updateGuardOperation("guard-op-1", { status: "filled", orderRef: "42", filledQuantity: "0.3", at: instant(NOW + 1000) });
    expect(store.mandates.unresolvedGuardOperations()).toHaveLength(0);
    store.close();
  });
});

function guardFixture(initialQuantity: string, priceValue = "100", cap = "50", store = openStore(":memory:"), spotQuantity = "0.3") {
  const symbol = "SOLUSDT" as Symbol_;
  const price = fp.parse(priceValue);
  let position: FuturesPosition = {
    symbol,
    positionAmt: fp.parse(initialQuantity),
    entryPrice: fp.parse(initialQuantity === "0" ? "0" : priceValue),
    markPrice: price,
    liquidationPrice: null,
    unrealisedPnl: fp.parse("0"),
    leverage: 2,
    isolated: true,
    notional: fp.multiply(fp.abs(fp.parse(initialQuantity)), price),
  };
  let opened = 0;
  let reduced = 0;
  let marginChanges = 0;
  let leverageChanges = 0;
  const spotRules = {
    symbol,
    baseAsset: "SOL",
    quoteAsset: "USDT",
    tickSize: fp.parse("0.01"),
    stepSize: fp.parse("0.001"),
    minQuantity: fp.parse("0.001"),
    maxQuantity: fp.parse("1000"),
    minNotional: fp.parse("5"),
    marketMaxQuantity: null,
    notionalAveragePriceMinutes: 5,
  };
  const binance = {
    credentialed: true,
    filters: async () => ok(spotRules),
    market: async () => ok({ symbol, lastPrice: price, bestBid: price, bestAsk: price, averagePrice: price, observedAt: NOW, source: "fixture" }),
    account: async () => ok({ accountRef: "fixture", balances: [{ asset: "SOL", free: fp.parse(spotQuantity), locked: fp.parse("0") }], observedAt: NOW, canTradeSpot: true }),
  } as BinanceClient;
  const futures = {
    filters: async () => ok({ symbol, stepSize: fp.parse("0.001"), minQuantity: fp.parse("0.001"), maxQuantity: fp.parse("1000"), minNotional: fp.parse("20"), quantityPrecision: 3, tickSize: fp.parse("0.01") }),
    position: async () => ok(position),
    markPrice: async () => ok(price),
    balances: async () => ok([{ asset: "USDT", balance: fp.parse("100"), available: fp.parse("100") }]),
    setIsolated: async () => { marginChanges += 1; return ok(true as const); },
    setLeverage: async () => { leverageChanges += 1; return ok(true as const); },
    open: async (input: { readonly quantity: ReturnType<typeof fp.parse>; readonly clientOrderId: string }) => {
      opened += 1;
      position = { ...position, positionAmt: fp.negate(input.quantity), entryPrice: price, notional: fp.multiply(input.quantity, price) };
      return ok({ orderRef: "open-1", clientOrderId: input.clientOrderId, status: "FILLED", filledQuantity: input.quantity, averagePrice: price });
    },
    close: async (input: { readonly quantity: ReturnType<typeof fp.parse>; readonly clientOrderId: string }) => {
      reduced += 1;
      const remaining = fp.subtract(fp.abs(position.positionAmt), input.quantity);
      position = { ...position, positionAmt: fp.negate(remaining), notional: fp.multiply(remaining, price) };
      return ok({ orderRef: "close-1", clientOrderId: input.clientOrderId, status: "FILLED", filledQuantity: input.quantity, averagePrice: price });
    },
  } as FuturesClient;
  const runtime = createRuntime({
    config: loadConfig({
      TELT_OWNER_WHATSAPP: "+12025550123",
      TELT_X402_PRIVATE_KEY: `0x${"a".repeat(64)}`,
      TELT_MODE: "live",
      TELT_LIVE_EXECUTION: "true",
      TELT_MAX_FUTURES_NOTIONAL: cap,
      TELT_MAX_TOTAL_EXPOSURE: cap,
      TELT_MAX_TOTAL_HEDGE_NOTIONAL: cap,
    }),
    clock: { now: () => NOW },
    store,
    binance,
    futures,
    log: createLogger({ level: "silent" }),
    newId: (prefix) => `${prefix}-test`,
  });
  return { runtime, store, counts: () => ({ opened, reduced, marginChanges, leverageChanges }), position: () => position };
}

describe("Guard Mode execution", () => {
  it("accepts liquid Binance symbols and opens the initial hedge", async () => {
    const context = guardFixture("0");
    expect(context.runtime.guard.arm({ symbol: "SOLUSDT", coverageBps: 10000, leverage: 2, hours: 24 })).toContain("Guard Mode armed");
    const result = await context.runtime.checkPositions();
    expect(result.checked).toBeGreaterThan(0);
    expect(context.counts().opened).toBe(1);
    expect(fp.equals(fp.abs(context.position().positionAmt), fp.parse("0.3"))).toBe(true);
    expect(context.store.mandates.unresolvedGuardOperations()).toHaveLength(0);
    expect(context.store.safetyState().killSwitchEngaged).toBe(false);
    context.runtime.close();
  });

  it("reduces an overhedged position in a bounded cycle", async () => {
    const context = guardFixture("-0.8", "400", "250");
    context.runtime.guard.arm({ symbol: "SOLUSDT", coverageBps: 10000, leverage: 2, hours: 24 });
    const result = await context.runtime.checkPositions();
    expect(result.lines.join(" ").toLowerCase()).toContain("overhedged");
    expect(context.counts()).toEqual({ opened: 0, reduced: 1, marginChanges: 0, leverageChanges: 0 });
    expect(fp.equals(fp.abs(context.position().positionAmt), fp.parse("0.74"))).toBe(true);
    expect(context.store.safetyState().killSwitchEngaged).toBe(false);
    context.runtime.close();
  });

  it("removes the remaining hedge after the Spot holding reaches zero", async () => {
    const context = guardFixture("-0.3", "100", "50", openStore(":memory:"), "0");
    context.runtime.guard.arm({ symbol: "SOLUSDT", coverageBps: 10000, leverage: 2, hours: 24 });
    const result = await context.runtime.checkPositions();
    expect(result.lines.join(" ").toLowerCase()).toContain("overhedged");
    expect(context.counts().reduced).toBe(1);
    expect(fp.isZero(context.position().positionAmt)).toBe(true);
    expect(context.store.mandates.adopted("SOLUSDT")).toBeNull();
    context.runtime.close();
  });

  it("does not run Guard orders while the kill switch is engaged", async () => {
    const context = guardFixture("0");
    context.runtime.guard.arm({ symbol: "SOLUSDT", coverageBps: 10000, leverage: 2, hours: 24 });
    context.store.engageKillSwitch("operator stop", NOW);
    const result = await context.runtime.checkPositions();
    expect(result.halted).toContain("operator stop");
    expect(context.counts().opened).toBe(0);
    context.runtime.close();
  });

  it("stops on startup when a previous adjustment is unresolved", () => {
    const store = openStore(":memory:");
    store.mandates.claimGuardOperation({
      id: "guard-op-crashed",
      mandateId: "guard-crashed",
      symbol: "SOLUSDT",
      idempotencyKey: "guard-crashed-key",
      clientOrderId: "guard-crashed-client",
      action: "increase",
      quantity: "0.3",
      status: "submitted",
      orderRef: null,
      filledQuantity: "0",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const context = guardFixture("0", "100", "50", store);
    expect(context.store.safetyState().killSwitchEngaged).toBe(true);
    expect(context.store.safetyState().killSwitchReason).toContain("unresolved adjustment");
    context.runtime.close();
  });
});
