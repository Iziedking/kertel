import { describe, expect, it } from "vitest";
import { instant } from "@telt/core/domain";
import * as fp from "@telt/core/money";
import { classifyGuard } from "../src/guard.js";
import { openStore } from "../src/infra/store.js";

const NOW = instant(Date.parse("2026-09-08T12:00:00.000Z"));
const q = (value: string) => fp.parse(value);

describe("Guard Mode", () => {
  it("distinguishes protected, drift and unprotected exposure", () => {
    const base = { targetCoverageBps: 10000, toleranceBps: 100, maxAgeMs: 30000, observedAt: NOW, now: NOW, marketAvailable: true };
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("1") }).state).toBe("protected");
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("0.8") }).state).toBe("underhedged");
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("1.2") }).state).toBe("overhedged");
    expect(classifyGuard({ ...base, spotQuantity: q("1"), futuresShortQuantity: q("0") }).state).toBe("unprotected");
  });

  it("fails closed on stale data", () => {
    const result = classifyGuard({ targetCoverageBps: 10000, toleranceBps: 100, maxAgeMs: 30000, spotQuantity: q("1"), futuresShortQuantity: q("1"), observedAt: instant(NOW - 31_000), now: NOW, marketAvailable: true });
    expect(result.state).toBe("unknown");
  });

  it("persists, checkpoints and revokes a mandate across store calls", () => {
    const store = openStore(":memory:");
    store.mandates.saveProtection({ id: "guard-1", symbol: "SOLUSDT", targetCoverageBps: 10000, toleranceBps: 150, maxNotional: "50", leverage: 2, maxAdjustmentBps: 2000, version: 1, createdAt: NOW, expiresAt: instant(NOW + 86_400_000), cooldownMs: 60_000, status: "active", lastActionAt: null, checkpointAt: NOW, lastState: "armed" });
    expect(store.mandates.activeProtection("SOLUSDT")?.id).toBe("guard-1");
    store.mandates.checkpointProtection("guard-1", { at: instant(NOW + 1000), state: "underhedged" });
    expect(store.mandates.activeProtection("SOLUSDT")?.lastState).toBe("underhedged");
    store.mandates.revokeProtection("guard-1", instant(NOW + 2000));
    expect(store.mandates.activeProtection("SOLUSDT")).toBeNull();
    store.close();
  });
});

