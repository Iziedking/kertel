import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";

import { createFixtureX402Client } from "../src/fixture.js";
import type { FixtureExchange } from "../src/fixture.js";
import type { ApprovedQuote, PaidRequest, X402Quote } from "../src/types.js";

/**
 * The point of these tests is not that the fixture client returns data. It is
 * that the fixture client can *fail* — that feeding it a tampered challenge, a
 * moved recipient or a raised price produces the same refusal the live client
 * would produce, with no wallet anywhere near it.
 *
 * A stub that returned a canned observation would pass none of them, which is
 * the argument for building fixture mode this way.
 */

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

function challengeText(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../fixtures/x402/live-quotes/${name}`, import.meta.url)),
    "utf8",
  );
}

const COINGECKO_REQUEST: PaidRequest = {
  providerId: "coingecko",
  endpointId: "coingecko:simple/price",
  url: "https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=ethereum&vs_currencies=usd",
  method: "GET",
};

const CMC_REQUEST: PaidRequest = {
  providerId: "coinmarketcap",
  endpointId: "coinmarketcap:quotes/latest",
  url: "https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=ETH",
  method: "GET",
};

const PRICE_BODY = JSON.stringify({ ethereum: { usd: 2505.66 } });

function client(exchanges: Record<string, FixtureExchange>, walletConfigured = true) {
  return createFixtureX402Client({ exchanges, hash: sha256, walletConfigured });
}

function bodyChallenge(file: string, paidBody = PRICE_BODY): FixtureExchange {
  return {
    probe: { status: 402, bodyText: challengeText(file) },
    paid: { status: 200, bodyText: paidBody },
  };
}

/** The same challenge, delivered in the header with an empty body. */
function headerChallenge(file: string): FixtureExchange {
  return {
    probe: {
      status: 402,
      headers: {
        "payment-required": Buffer.from(challengeText(file), "utf8").toString("base64"),
      },
      bodyText: "",
    },
    paid: { status: 200, bodyText: PRICE_BODY },
  };
}

async function quoteOf(
  exchanges: Record<string, FixtureExchange>,
  request: PaidRequest = COINGECKO_REQUEST,
): Promise<X402Quote> {
  const result = await client(exchanges).quote(request);
  if (!result.ok) {
    throw new Error(`expected a quote, got ${result.error.code}: ${result.error.detail}`);
  }
  if (result.value.kind !== "payment_required") {
    throw new Error("expected the endpoint to be priced");
  }
  return result.value.quote;
}

function approval(quote: X402Quote, approvedAmount = quote.amount): ApprovedQuote {
  return { quote, approvedAmount, approvedAt: 1_788_744_170_000 };
}

describe("the fixture client reads a real challenge the same way the live one does", () => {
  it("prices CoinGecko on Base and CoinMarketCap on Binance's own rail", async () => {
    const gecko = await quoteOf({
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    });
    expect(gecko.rail).toBe("base-usdc");
    expect(gecko.facilitator).toBe("Base x402");
    expect(fp.format(gecko.amount)).toBe("0.01");

    const cmc = await quoteOf(
      { "coinmarketcap:quotes/latest": bodyChallenge("coinmarketcap-quotes-latest.json") },
      CMC_REQUEST,
    );
    // Seven options offered, permit2 first among them, eighteen decimals.
    expect(cmc.rail).toBe("bsc-u");
    expect(cmc.facilitator).toBe("Binance B402");
    expect(fp.format(cmc.amount)).toBe("0.01");
    expect(cmc.offeredOptions).toBe(7);
  });

  it("finds the challenge in the header as well as the body", async () => {
    const fromBody = await quoteOf({
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    });
    const fromHeader = await quoteOf({
      "coingecko:simple/price": headerChallenge("coingecko-simple-price-402.json"),
    });

    expect(fromBody.challengeSource).toBe("body");
    expect(fromHeader.challengeSource).toBe("header");
    expect(fp.equals(fromBody.amount, fromHeader.amount)).toBe(true);
  });

  it("takes a free answer as free rather than as a failure", async () => {
    const result = await client({
      "coingecko:simple/price": { probe: { status: 200, bodyText: PRICE_BODY } },
    }).quote(COINGECKO_REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("free");
  });
});

describe("the fixture client still refuses what the live one would refuse", () => {
  it("refuses a challenge that names a recipient other than the pinned one", async () => {
    const tampered = JSON.parse(challengeText("coingecko-simple-price-402.json")) as {
      accepts: { payTo: string }[];
    };
    for (const option of tampered.accepts) {
      option.payTo = "0xAttacker0000000000000000000000000000dEaD";
    }

    const result = await client({
      "coingecko:simple/price": {
        probe: { status: 402, bodyText: JSON.stringify(tampered) },
        paid: { status: 200, bodyText: PRICE_BODY },
      },
    }).quote(COINGECKO_REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_RECIPIENT_MISMATCH");
  });

  it("refuses a url whose host is not the pinned one", async () => {
    const result = await client({
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    }).quote({
      ...COINGECKO_REQUEST,
      url: "https://pro-api.coingecko.com.attacker.test/api/v3/x402/simple/price",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_RECIPIENT_MISMATCH");
  });

  it("refuses a provider it holds no pin for", async () => {
    const result = await client({ "unknown:thing": bodyChallenge("coingecko-simple-price-402.json") }).quote({
      providerId: "unknown",
      endpointId: "unknown:thing",
      url: "https://example.test/data",
      method: "GET",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_RECIPIENT_MISMATCH");
  });

  it("refuses a price that rose between the quote and the payment", async () => {
    const exchanges = {
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    };
    const quote = await quoteOf(exchanges);

    // Approved at one cent; the caller then tries to pay a two-cent approval's
    // worth. Turn it around: the approval is for less than the live challenge.
    const result = await client(exchanges).pay(
      COINGECKO_REQUEST,
      approval(quote, fp.parse("0.005")),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_CALL_ABOVE_PER_CALL_CAP");
  });

  it("refuses when the recipient moved between the quote and the payment", async () => {
    const exchanges = {
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    };
    const quote = await quoteOf(exchanges);
    const stale: X402Quote = { ...quote, payTo: "0x0000000000000000000000000000000000000001" };

    const result = await client(exchanges).pay(COINGECKO_REQUEST, {
      quote: stale,
      approvedAmount: quote.amount,
      approvedAt: 1_788_744_170_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_RECIPIENT_MISMATCH");
  });

  it("refuses to pay with no wallet configured", async () => {
    const exchanges = {
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    };
    const quote = await quoteOf(exchanges);
    const noWallet = client(exchanges, false);

    expect(noWallet.walletConfigured).toBe(false);
    expect(noWallet.payerAddress).toBeNull();

    const result = await noWallet.pay(COINGECKO_REQUEST, approval(quote));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_WALLET_NOT_CONFIGURED");
  });

  it("calls a signed payment with no answer unknown, never a clean failure", async () => {
    const exchanges = {
      "coingecko:simple/price": { probe: { status: 402, bodyText: challengeText("coingecko-simple-price-402.json") } },
    };
    const quote = await quoteOf(exchanges);

    const result = await client(exchanges).pay(COINGECKO_REQUEST, approval(quote));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_PAYMENT_UNKNOWN");
    expect(result.error.detail).toContain("did not get an answer");
  });

  it("reports a rejected payment separately from an unknown one", async () => {
    const exchanges = {
      "coingecko:simple/price": {
        probe: { status: 402, bodyText: challengeText("coingecko-simple-price-402.json") },
        paid: { status: 402, bodyText: JSON.stringify({ error: "invalid signature" }) },
      },
    };
    const quote = await quoteOf(exchanges);

    const result = await client(exchanges).pay(COINGECKO_REQUEST, approval(quote));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_PAYMENT_REJECTED");
  });

  it("refuses to pay an endpoint that stopped charging", async () => {
    const priced = {
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    };
    const quote = await quoteOf(priced);

    const nowFree = client({
      "coingecko:simple/price": { probe: { status: 200, bodyText: PRICE_BODY } },
    });
    const result = await nowFree.pay(COINGECKO_REQUEST, approval(quote));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("X402_NO_ACCEPTABLE_OPTION");
    expect(result.error.detail).toContain("stopped charging");
  });

  it("says plainly when a fixture is simply missing", async () => {
    const result = await client({}).quote(COINGECKO_REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(result.error.detail).toContain("Fixture mode has no saved answer");
  });
});

describe("a successful fixture payment", () => {
  it("returns the body, its hash, the amount and a settlement", async () => {
    const exchanges = {
      "coingecko:simple/price": bodyChallenge("coingecko-simple-price-402.json"),
    };
    const quote = await quoteOf(exchanges);
    const result = await client(exchanges).pay(COINGECKO_REQUEST, approval(quote));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(200);
    expect(result.value.bodyHash).toBe(sha256(PRICE_BODY));
    expect(fp.format(result.value.amountPaid)).toBe("0.01");
    expect(result.value.settlement?.success).toBe(true);
    expect(result.value.settlement?.network).toBe("eip155:8453");
  });
});
