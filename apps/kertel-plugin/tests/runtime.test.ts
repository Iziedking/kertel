import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as fp from "@kertel/core/money";
import { fixedClock, instant } from "@kertel/core/domain";
import type { FixtureExchange } from "@kertel/x402";

import { loadConfig } from "../src/infra/config.js";
import { createLogger } from "../src/infra/logger.js";
import { openStore } from "../src/infra/store.js";
import type { Store } from "../src/infra/store.js";
import { createRuntime } from "../src/runtime.js";
import { statusTool } from "../src/tools/status.js";
import { researchTool } from "../src/tools/research.js";

const NOW = instant(Date.parse("2026-09-07T12:00:00.000Z"));
const KEY = `0x${"a".repeat(64)}`;
const OWNER = "+2348067053854";

function challenge(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../fixtures/x402/live-quotes/${name}`, import.meta.url)),
    "utf8",
  );
}

const BINANCE_BODY = JSON.stringify({
  symbol: "ETHUSDT",
  priceChangePercent: "0.503",
  lastPrice: "2505.65000000",
  bidPrice: "2505.65000000",
  askPrice: "2505.66000000",
  closeTime: 1788744167977,
});

function exchanges(overrides: Record<string, FixtureExchange> = {}): Record<string, FixtureExchange> {
  return {
    "coingecko:simple/price": {
      probe: { status: 402, bodyText: challenge("coingecko-simple-price-402.json") },
      paid: { status: 200, bodyText: JSON.stringify({ ethereum: { usd: 2505.66 } }) },
    },
    "nansen:smart-money/netflow": {
      probe: { status: 402, bodyText: challenge("nansen-smart-money-netflow.json") },
      paid: {
        status: 200,
        bodyText: JSON.stringify({
          data: [
            {
              token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              token_symbol: "WETH",
              chain: "ethereum",
              net_flow_24h_usd: 5400000.25,
              trader_count: 143,
            },
          ],
          pagination: {},
        }),
      },
    },
    ...overrides,
  };
}

const venueFetch = ((async (url: string | URL) => {
  if (!String(url).startsWith("https://api.binance.com/")) {
    throw new Error(`unexpected url ${String(url)}`);
  }
  return new Response(BINANCE_BODY, { status: 200 });
}) as unknown) as typeof globalThis.fetch;

function build(options: { store?: Store; exchanges?: Record<string, FixtureExchange> } = {}) {
  const store = options.store ?? openStore(":memory:");
  const runtime = createRuntime({
    config: loadConfig({ KERTEL_OWNER_WHATSAPP: OWNER, KERTEL_X402_PRIVATE_KEY: KEY }),
    clock: fixedClock(NOW),
    store,
    log: createLogger({ level: "silent" }),
    exchanges: options.exchanges ?? exchanges(),
    fetchImpl: venueFetch,
  });
  return { runtime, store };
}

describe("a research run, end to end in fixture mode", () => {
  it("answers a price check for a cent and says what it did not buy", async () => {
    const { runtime } = build();
    const result = await runtime.research({ symbol: "ETHUSDT", goal: "price_check" });

    expect(result.ok).toBe(true);
    expect(result.spent).toBe("0.01");
    expect(result.body).toContain("Binance: 2505.65000000 (free)");
    expect(result.body).toContain("CoinGecko: 2505.66 ($0.01)");
    expect(result.body).toContain("Nansen Smart Money");
    expect(result.body).toContain("saved $0.05");
    // Fixture mode must never be mistaken for the real thing.
    expect(result.body).toContain("FIXTURE MODE");
    runtime.close();
  });

  it("answers a trade thesis for six cents, over Binance's own rail", async () => {
    const { runtime } = build();
    const result = await runtime.research({ symbol: "ETHUSDT", goal: "trade_thesis" });

    expect(result.ok).toBe(true);
    expect(result.spent).toBe("0.06");
    expect(result.body).toContain("24h net flow");
    expect(result.body).toContain("Nansen Smart Money $0.05 via Binance B402");
    runtime.close();
  });

  it("writes the spend to the ledger, so a restart cannot refund the budget", async () => {
    const store = openStore(":memory:");
    const first = build({ store });
    await first.runtime.research({ symbol: "ETHUSDT", goal: "trade_thesis" });
    expect(fp.equals(store.spentOn(NOW), fp.parse("0.06"))).toBe(true);

    // A new runtime over the same database: the day's spend is still there.
    const second = build({ store, exchanges: exchanges() });
    await second.runtime.research({ symbol: "ETHUSDT", goal: "price_check" });
    expect(fp.equals(store.spentOn(NOW), fp.parse("0.07"))).toBe(true);
    store.close();
  });

  it("records every payment attempt, whatever the outcome", async () => {
    const store = openStore(":memory:");
    const { runtime } = build({ store });
    await runtime.research({ symbol: "ETHUSDT", goal: "trade_thesis" });
    // Nothing unresolved on a clean run.
    expect(store.unresolvedPayments()).toHaveLength(0);
    store.close();
  });
});

describe("what a research run refuses to do", () => {
  it("refuses a symbol outside the allowed list, before calling anything", async () => {
    const { runtime, store } = build();
    const result = await runtime.research({ symbol: "DOGEUSDT", goal: "price_check" });

    expect(result.ok).toBe(false);
    expect(result.refusalCode).toBe("SYMBOL_NOT_ALLOWED");
    expect(result.spent).toBe("0.00");
    expect(fp.isZero(store.spentOn(NOW))).toBe(true);
    runtime.close();
  });

  it("refuses everything while the kill switch is engaged", async () => {
    const store = openStore(":memory:");
    store.engageKillSwitch("owner asked to stop", NOW);
    const { runtime } = build({ store });

    const result = await runtime.research({ symbol: "ETHUSDT", goal: "trade_thesis" });
    expect(result.refusalCode).toBe("KILL_SWITCH_ENGAGED");
    expect(result.spent).toBe("0.00");
    store.close();
  });

  it("refuses cheaply when the venue price cannot be read", async () => {
    const store = openStore(":memory:");
    const runtime = createRuntime({
      config: loadConfig({ KERTEL_OWNER_WHATSAPP: OWNER, KERTEL_X402_PRIVATE_KEY: KEY }),
      clock: fixedClock(NOW),
      store,
      log: createLogger({ level: "silent" }),
      exchanges: exchanges(),
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof globalThis.fetch,
    });

    const result = await runtime.research({ symbol: "ETHUSDT", goal: "trade_thesis" });
    expect(result.refusalCode).toBe("PROVIDER_UNAVAILABLE");
    expect(result.spent).toBe("0.00");
    expect(fp.isZero(store.spentOn(NOW))).toBe(true);
    store.close();
  });

  it("stops everything after a payment that was signed and never confirmed", async () => {
    // No `paid` response for Nansen: signed, sent, silence.
    const store = openStore(":memory:");
    const { runtime } = build({
      store,
      exchanges: exchanges({
        "nansen:smart-money/netflow": {
          probe: { status: 402, bodyText: challenge("nansen-smart-money-netflow.json") },
        },
      }),
    });

    const result = await runtime.research({ symbol: "ETHUSDT", goal: "trade_thesis" });

    // The money is charged pessimistically and written down.
    expect(result.spent).toBe("0.06");
    expect(store.unresolvedPayments()).toHaveLength(1);

    // And the kill switch is on, because Kertel can no longer say what it spent.
    expect(store.safetyState().killSwitchEngaged).toBe(true);

    // Which the next request feels immediately.
    const next = await runtime.research({ symbol: "ETHUSDT", goal: "price_check" });
    expect(next.refusalCode).toBe("KILL_SWITCH_ENGAGED");
    store.close();
  });
});

describe("the tools as OpenClaw sees them", () => {
  it("are named, owner-only, and describe their own cost", () => {
    const { runtime } = build();
    const research = researchTool(runtime);
    const status = statusTool(runtime);

    for (const tool of [research, status]) {
      // A name that clashes with a core tool is skipped silently, so the prefix
      // is not cosmetic.
      expect(tool.name.startsWith("kertel_")).toBe(true);
      expect(tool.ownerOnly).toBe(true);
    }
    expect(research.description).toContain("$0.01");
    expect(research.description).toContain("$0.06");
    runtime.close();
  });

  it("refuse a goal they were not given, rather than picking the dear one", async () => {
    const { runtime } = build();
    const result = await researchTool(runtime).execute("call-1", { symbol: "ETHUSDT" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("price_check or a trade_thesis");
    runtime.close();
  });

  it("run the ladder when given both", async () => {
    const { runtime } = build();
    const result = await researchTool(runtime).execute("call-2", {
      symbol: "ethusdt",
      goal: "price_check",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("Price check: ETHUSDT");
    runtime.close();
  });

  it("report the capability truth table without touching the network", async () => {
    const { runtime } = build();
    const result = await statusTool(runtime).execute("call-3", {});
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Mode: fixture");
    expect(text).toContain("Paid research over x402:            ready");
    expect(text).toContain("Live order execution:               unavailable");
    expect(text).toContain("Kill switch: off");
    runtime.close();
  });

  it("show an engaged kill switch and the unresolved payment behind it", async () => {
    const store = openStore(":memory:");
    store.engageKillSwitch("a payment was signed and never confirmed", NOW);
    store.recordPaymentAttempt({
      attemptId: "pay-x",
      provider: "nansen",
      endpointId: "nansen:smart-money/netflow",
      chargedUsdc: "0.05",
      rail: "bsc-u",
      facilitator: "Binance B402",
      settlementTx: null,
      outcome: "unknown",
      refusalCode: "X402_PAYMENT_UNKNOWN",
      at: NOW,
    });
    const { runtime } = build({ store });

    const result = await statusTool(runtime).execute("call-4", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("KILL SWITCH ENGAGED");
    expect(text).toContain("signed and never confirmed");
    expect(text).toContain("Reconcile these before resuming");
    store.close();
  });
});
