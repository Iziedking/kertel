import { describe, expect, it } from "vitest";

import * as fp from "@kertel/core/money";
import { fixedClock, instant, ok, refuse } from "@kertel/core/domain";
import type { Symbol_ } from "@kertel/core/domain";

import type { BinanceClient, PlacedOrder } from "../src/infra/binance.js";
import { loadConfig } from "../src/infra/config.js";
import { createLogger } from "../src/infra/logger.js";
import { openStore } from "../src/infra/store.js";
import type { Store } from "../src/infra/store.js";
import { createRuntime } from "../src/runtime.js";

const NOW = instant(Date.parse("2026-09-07T12:00:00.000Z"));
const OWNER = "+2348067053854";
const KEY = `0x${"a".repeat(64)}`;
const ETHUSDT = "ETHUSDT" as Symbol_;

/** The real ETHUSDT filters, from fixtures/binance/exchange-info-2026-09-07.json. */
const FILTERS = {
  symbol: ETHUSDT,
  baseAsset: "ETH",
  quoteAsset: "USDT",
  tickSize: fp.parse("0.01"),
  stepSize: fp.parse("0.00010000"),
  minQuantity: fp.parse("0.00010000"),
  maxQuantity: fp.parse("9000.00000000"),
  minNotional: fp.parse("5.00000000"),
  marketMaxQuantity: fp.parse("2192.93460666"),
  notionalAveragePriceMinutes: 5,
};

type FakeOptions = {
  readonly averagePrice?: string | null;
  readonly ask?: string;
  readonly balance?: string;
  readonly onPlace?: () => Awaited<ReturnType<BinanceClient["placeMarketOrder"]>>;
  readonly onFind?: () => Awaited<ReturnType<BinanceClient["findOrder"]>>;
};

function filled(quantity: string, price: string): PlacedOrder {
  return {
    exchangeOrderRef: "123456",
    clientOrderId: "kertel-test",
    status: "filled",
    filledQuantity: fp.parse(quantity),
    averagePrice: fp.parse(price),
    feePaid: fp.parse("0.01"),
    raw: {},
  };
}

function fakeBinance(options: FakeOptions = {}): BinanceClient & { placements: number } {
  const ask = options.ask ?? "2505.66";
  const client = {
    placements: 0,
    credentialed: true,
    async filters() {
      return ok(FILTERS);
    },
    async market() {
      return ok({
        symbol: ETHUSDT,
        lastPrice: fp.parse(ask),
        bestBid: fp.parse(ask),
        bestAsk: fp.parse(ask),
        averagePrice:
          options.averagePrice === undefined
            ? fp.parse(ask)
            : options.averagePrice === null
              ? null
              : fp.parse(options.averagePrice),
        observedAt: NOW,
        source: "test",
      });
    },
    async account() {
      return ok({
        accountRef: "test",
        canTradeSpot: true,
        observedAt: NOW,
        balances: [
          { asset: "USDT", free: fp.parse(options.balance ?? "500.00"), locked: fp.parse("0") },
          { asset: "ETH", free: fp.parse("1.0"), locked: fp.parse("0") },
        ],
      });
    },
    async placeMarketOrder() {
      client.placements += 1;
      return options.onPlace === undefined ? ok(filled("0.0039", "2505.70")) : options.onPlace();
    },
    async findOrder() {
      return options.onFind === undefined ? ok(null) : options.onFind();
    },
  };
  return client as unknown as BinanceClient & { placements: number };
}

function build(options: {
  store?: Store;
  binance?: BinanceClient;
  live?: boolean;
} = {}) {
  const store = options.store ?? openStore(":memory:");
  const binance = options.binance ?? fakeBinance();
  const runtime = createRuntime({
    config: loadConfig({
      KERTEL_OWNER_WHATSAPP: OWNER,
      KERTEL_X402_PRIVATE_KEY: KEY,
      KERTEL_BINANCE_API_KEY: "k",
      KERTEL_BINANCE_API_SECRET: "s",
      ...(options.live === true
        ? { KERTEL_MODE: "live", KERTEL_LIVE_EXECUTION: "true" }
        : {}),
    }),
    clock: fixedClock(NOW),
    store,
    log: createLogger({ level: "silent" }),
    binance,
    // Deterministic, so the code in the message is the code the test types back.
    random: (count: number) => new Uint8Array(count).fill(7),
    newId: (prefix: string) => `${prefix}-test`,
  });
  return { runtime, store, binance };
}

/** The code is only ever in the outbound message, which is the point. */
function codeFrom(body: string): string {
  const match = /KTL-[A-Z0-9]+/.exec(body);
  if (match === null) throw new Error(`no confirmation code in:\n${body}`);
  return match[0];
}

describe("preparing an order", () => {
  it("shows the numbers that will actually be sent", async () => {
    const { runtime } = build();
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });

    expect(result.ok).toBe(true);
    expect(result.body).toContain("BUY ETHUSDT");
    expect(result.body).toContain("ETH");
    expect(result.body).toContain("Worst fill Kertel will accept");
    expect(result.body).toContain("confirm KTL-");
    expect(result.body).toContain("Reply  cancel");
    runtime.close();
  });

  it("says how much the exchange step size left unspent", async () => {
    const { runtime } = build();
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    // 10 / 2505.66 floored to 0.0001 steps cannot spend the full ten.
    expect(result.body).toContain("unspent");
    runtime.close();
  });

  it("refuses below the exchange minimum and names the shortfall", async () => {
    const { runtime } = build();
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "3" });

    expect(result.ok).toBe(false);
    expect(result.refusalCode).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
    expect(result.body).toContain("5.00");
    runtime.close();
  });

  it("refuses above the configured per-trade cap", async () => {
    const { runtime } = build();
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "100" });
    expect(result.refusalCode).toBe("NOTIONAL_ABOVE_CAP");
    runtime.close();
  });

  it("checks the minimum against the venue average, not just the last price", async () => {
    // Sized at the ask this clears 5.00; against the venue's own five-minute
    // average it does not, and the exchange would reject it.
    const { runtime } = build({ binance: fakeBinance({ ask: "2505.66", averagePrice: "2000.00" }) });
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "5.10" });

    expect(result.ok).toBe(false);
    expect(result.refusalCode).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
    runtime.close();
  });

  it("says when no venue average was available", async () => {
    const { runtime } = build({ binance: fakeBinance({ averagePrice: null }) });
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    expect(result.body).toContain("No venue average available");
    runtime.close();
  });

  it("refuses when the balance will not cover it", async () => {
    const { runtime } = build({ binance: fakeBinance({ balance: "1.00" }) });
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "20" });
    expect(result.refusalCode).toBe("INSUFFICIENT_BALANCE");
    runtime.close();
  });

  it("refuses an amount it cannot read, rather than guessing", async () => {
    const { runtime } = build();
    const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "ten dollars" });
    expect(result.refusalCode).toBe("AMOUNT_NOT_UNDERSTOOD");
    runtime.close();
  });
});

describe("confirming an order", () => {
  it("stops at the live write gate after everything else passed", async () => {
    const { runtime, binance } = build();
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const result = await runtime.confirm(codeFrom(proposal.body));

    expect(result.refusalCode).toBe("LIVE_EXECUTION_DISABLED");
    expect(result.body).toContain("Everything up to this point passed");
    expect((binance as unknown as { placements: number }).placements).toBe(0);
    runtime.close();
  });

  it("leaves the code usable after a dry run, so rehearsing is free", async () => {
    const { runtime } = build();
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const code = codeFrom(proposal.body);

    const first = await runtime.confirm(code);
    const second = await runtime.confirm(code);
    // Same refusal both times: the rehearsal did not burn anything.
    expect(first.refusalCode).toBe("LIVE_EXECUTION_DISABLED");
    expect(second.refusalCode).toBe("LIVE_EXECUTION_DISABLED");
    runtime.close();
  });

  it("refuses in fixture mode even when the execution flag is on", async () => {
    // The flag says the operator wants trading; the mode says there is no live
    // rail behind it. The refusal names the mode rather than the flag.
    const store = openStore(":memory:");
    const binance = fakeBinance();
    const runtime = createRuntime({
      config: loadConfig({
        KERTEL_OWNER_WHATSAPP: OWNER,
        KERTEL_X402_PRIVATE_KEY: KEY,
        KERTEL_BINANCE_API_KEY: "k",
        KERTEL_BINANCE_API_SECRET: "s",
        KERTEL_LIVE_EXECUTION: "true",
      }),
      clock: fixedClock(NOW),
      store,
      log: createLogger({ level: "silent" }),
      binance,
      random: (count: number) => new Uint8Array(count).fill(7),
      newId: (prefix: string) => `${prefix}-test`,
    });

    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const result = await runtime.confirm(codeFrom(proposal.body));

    expect(result.refusalCode).toBe("LIVE_EXECUTION_DISABLED");
    expect(result.body).toContain("fixture mode");
    expect((binance as unknown as { placements: number }).placements).toBe(0);
    store.close();
  });

  it("refuses a code nobody issued", async () => {
    const { runtime } = build();
    await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const result = await runtime.confirm("KTL-ZZZZZZ");
    expect(result.refusalCode).toBe("TOKEN_NOT_FOUND");
    runtime.close();
  });

  it("refuses something that is not a code at all", async () => {
    const { runtime } = build();
    const result = await runtime.confirm("yes please");
    expect(result.refusalCode).toBe("TOKEN_NOT_FOUND");
    runtime.close();
  });

  it("places the order in live mode and reports the fill", async () => {
    const { runtime, binance } = build({ live: true });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const result = await runtime.confirm(codeFrom(proposal.body));

    expect(result.ok).toBe(true);
    expect(result.body).toContain("filled");
    expect(result.body).toContain("Avg price");
    expect(result.body).toContain("Order ref:   123456");
    expect((binance as unknown as { placements: number }).placements).toBe(1);
    runtime.close();
  });

  it("burns the code, so the same message twice places one order", async () => {
    const { runtime, binance } = build({ live: true });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const code = codeFrom(proposal.body);

    const first = await runtime.confirm(code);
    const second = await runtime.confirm(code);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect((binance as unknown as { placements: number }).placements).toBe(1);
    runtime.close();
  });

  it("will not execute a proposal that was cancelled", async () => {
    const { runtime, binance } = build({ live: true });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const code = codeFrom(proposal.body);

    runtime.cancel();
    const result = await runtime.confirm(code);

    expect(result.ok).toBe(false);
    expect((binance as unknown as { placements: number }).placements).toBe(0);
    runtime.close();
  });

  it("will not accept a code from a proposal whose numbers were altered", async () => {
    // The confirmation hash is recomputed from the stored proposal. Tampering
    // with any figure moves the hash and the code stops matching, so a changed
    // order can never be executed against a code the user approved.
    const store = openStore(":memory:");
    const { runtime } = build({ store, live: true });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const code = codeFrom(proposal.body);

    const row = store.trades.latestPreparedProposal(runtime.ownerHash as string);
    if (row === null) throw new Error("no proposal stored");
    store.trades.saveProposal({ ...row, quantity: "9.9999" });

    const result = await runtime.confirm(code);
    expect(result.ok).toBe(false);
    expect(result.refusalCode).toBe("TOKEN_NOT_FOUND");
    store.close();
  });
});

describe("an order whose result is unknown", () => {
  const timeout = () =>
    refuse(
      "EXECUTION_RESULT_UNKNOWN",
      "Kertel sent the order and did not get an answer.",
    ) as Awaited<ReturnType<BinanceClient["placeMarketOrder"]>>;

  it("stops everything rather than reporting a clean failure", async () => {
    const store = openStore(":memory:");
    const { runtime } = build({ store, live: true, binance: fakeBinance({ onPlace: timeout }) });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    const result = await runtime.confirm(codeFrom(proposal.body));

    expect(result.refusalCode).toBe("EXECUTION_RESULT_UNKNOWN");
    expect(store.safetyState().killSwitchEngaged).toBe(true);
    expect(store.trades.unreconciledOperations()).toHaveLength(1);
    store.close();
  });

  it("closes it when the exchange never saw the order", async () => {
    const store = openStore(":memory:");
    const binance = fakeBinance({ onPlace: timeout, onFind: () => ok(null) });
    const { runtime } = build({ store, live: true, binance });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    await runtime.confirm(codeFrom(proposal.body));

    const report = await runtime.reconcile();
    expect(report).toContain("never reached the exchange");
    expect(store.trades.unreconciledOperations()).toHaveLength(0);
    store.close();
  });

  it("records the truth when the order did reach the exchange", async () => {
    const store = openStore(":memory:");
    const binance = fakeBinance({
      onPlace: timeout,
      onFind: () => ok(filled("0.0039", "2506.10")),
    });
    const { runtime } = build({ store, live: true, binance });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    await runtime.confirm(codeFrom(proposal.body));

    const report = await runtime.reconcile();
    expect(report).toContain("filled");
    expect(report).toContain("2506.10");
    expect(store.trades.unreconciledOperations()).toHaveLength(0);
    store.close();
  });

  it("blocks a new proposal until it is resolved", async () => {
    const store = openStore(":memory:");
    const { runtime } = build({ store, live: true, binance: fakeBinance({ onPlace: timeout }) });
    const proposal = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    await runtime.confirm(codeFrom(proposal.body));

    const next = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "10" });
    expect(next.ok).toBe(false);
    // The kill switch fires first; either refusal is a stop.
    expect(["KILL_SWITCH_ENGAGED", "PENDING_OPERATION_UNRECONCILED"]).toContain(next.refusalCode);
    store.close();
  });
});

describe("reconciliation", () => {
  it("says so plainly when there is nothing to do", async () => {
    const { runtime } = build();
    expect(await runtime.reconcile()).toContain("Nothing to reconcile");
    runtime.close();
  });

  it("lists an unconfirmed research payment with what to check", async () => {
    const store = openStore(":memory:");
    store.recordPaymentAttempt({
      attemptId: "pay-1",
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

    const report = await runtime.reconcile();
    expect(report).toContain("payment pay-1");
    expect(report).toContain("chain explorer");
    expect(report).toContain("Kertel stays stopped");
    store.close();
  });
});
