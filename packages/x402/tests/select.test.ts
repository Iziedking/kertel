import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import * as fp from "@telt/core/money";
import type { Refusal, Result } from "@telt/core/domain";

import {
  BASE_NETWORK,
  BASE_USDC_ADDRESS,
  BSC_NETWORK,
  MERCHANT_PINS,
  PAYMENT_RAILS,
} from "../src/constants.js";
import {
  assertHostMatchesPin,
  buildQuote,
  pinFor,
  readChallenge,
  selectPaymentOption,
} from "../src/select.js";

/**
 * Every challenge in this suite is a real one, captured free from the live
 * provider on 2026-09-07 and committed under `fixtures/x402/live-quotes/`. A
 * test written against an imagined 402 shape passes and proves nothing; these
 * are the exact bytes that would arrive in production.
 */
function fixture(name: string): PaymentRequired {
  const path = fileURLToPath(
    new URL(`../../../fixtures/x402/live-quotes/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as PaymentRequired;
}

const CHALLENGES = {
  coingecko: () => fixture("coingecko-simple-price-402.json"),
  coinmarketcap: () => fixture("coinmarketcap-quotes-latest.json"),
  nansen: () => fixture("nansen-smart-money-netflow.json"),
  thegraph: () => fixture("thegraph-subgraph-402.json"),
} as const;

function expectOk<T>(result: Result<T, Refusal>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.detail}`);
  }
  return result.value;
}

function expectRefusal<T>(result: Result<T, Refusal>): Refusal {
  if (result.ok) {
    throw new Error("expected a refusal");
  }
  return result.error;
}

function headerFrom(map: Record<string, string>) {
  return (name: string): string | null => map[name.toLowerCase()] ?? null;
}

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("finding the challenge", () => {
  it("reads it from the header, which is how CoinGecko and The Graph send it", () => {
    // CoinGecko's body is {"error":"Payment required"}; The Graph's is empty.
    // A body-only reader reports both as broken rather than as priced.
    const result = expectOk(
      readChallenge({
        status: 402,
        getHeader: headerFrom({ "payment-required": base64(CHALLENGES.coingecko()) }),
        body: { error: "Payment required", message: "Payment is required to access this resource" },
      }),
    );
    expect(result.source).toBe("header");
    expect(result.challenge.accepts).toHaveLength(2);
  });

  it("reads it from the body, which is how CoinMarketCap and Nansen send it", () => {
    const result = expectOk(
      readChallenge({ status: 402, getHeader: () => null, body: CHALLENGES.coinmarketcap() }),
    );
    expect(result.source).toBe("body");
    expect(result.challenge.accepts).toHaveLength(7);
  });

  it("reads The Graph's header even though its body is empty", () => {
    const result = expectOk(
      readChallenge({
        status: 402,
        getHeader: headerFrom({ "payment-required": base64(CHALLENGES.thegraph()) }),
        body: "",
      }),
    );
    expect(result.source).toBe("header");
  });

  it("prefers the header when a provider sends both", () => {
    const result = expectOk(
      readChallenge({
        status: 402,
        getHeader: headerFrom({ "payment-required": base64(CHALLENGES.coingecko()) }),
        body: CHALLENGES.coinmarketcap(),
      }),
    );
    expect(result.source).toBe("header");
    expect(result.challenge.resource.url).toContain("coingecko");
  });

  it("refuses a status that is not 402", () => {
    expect(
      expectRefusal(readChallenge({ status: 200, getHeader: () => null, body: {} })).code,
    ).toBe("X402_NO_ACCEPTABLE_OPTION");
  });

  it("refuses a header that is not decodable base64 json", () => {
    expect(
      expectRefusal(
        readChallenge({
          status: 402,
          getHeader: headerFrom({ "payment-required": "not-base64-at-all!!" }),
          body: null,
        }),
      ).code,
    ).toBe("X402_NO_ACCEPTABLE_OPTION");
  });

  it("refuses decodable json that is not a challenge", () => {
    expect(
      expectRefusal(
        readChallenge({
          status: 402,
          getHeader: headerFrom({ "payment-required": base64({ hello: "world" }) }),
          body: null,
        }),
      ).code,
    ).toBe("X402_NO_ACCEPTABLE_OPTION");
  });

  it("refuses a 402 with nothing readable anywhere", () => {
    expect(
      expectRefusal(readChallenge({ status: 402, getHeader: () => null, body: "" })).code,
    ).toBe("X402_NO_ACCEPTABLE_OPTION");
  });
});

describe("choosing what to pay, against the live challenges", () => {
  it.each([
    ["coinmarketcap", "bsc-u", "0.01", 7, 3],
    ["nansen", "bsc-u", "0.05", 8, 3],
    ["coingecko", "base-usdc", "0.01", 2, 1],
    ["thegraph", "base-usdc", "0.01", 1, 1],
  ] as const)("picks the %s rail for %s at %s", (providerId, railId, price, offered, acceptable) => {
    const pin = expectOk(pinFor(providerId));
    const selected = expectOk(selectPaymentOption({ challenge: CHALLENGES[providerId](), pin }));

    expect(selected.rail.id).toBe(railId);
    expect(fp.format(selected.amount)).toBe(price);
    expect(selected.offeredOptions).toBe(offered);
    expect(selected.acceptableOptions).toBe(acceptable);
    expect(selected.option.payTo.toLowerCase()).toBe(pin.payTo.toLowerCase());
    expect(selected.option.network).toBe(selected.rail.network);
  });

  it("prefers Binance's own rail wherever a provider offers it", () => {
    // The reason the preference order exists. CoinMarketCap and Nansen both
    // take U on BNB Smart Chain, which settles through B402.
    for (const providerId of ["coinmarketcap", "nansen"] as const) {
      const pin = expectOk(pinFor(providerId));
      const selected = expectOk(selectPaymentOption({ challenge: CHALLENGES[providerId](), pin }));
      expect(selected.rail.network, providerId).toBe(BSC_NETWORK);
      expect(selected.rail.facilitator, providerId).toBe("Binance B402");
    }
  });

  it("falls back to Base USDC where BSC is not on offer", () => {
    // Without the fallback, two of the four sources would be unreachable.
    for (const providerId of ["coingecko", "thegraph"] as const) {
      const pin = expectOk(pinFor(providerId));
      const selected = expectOk(selectPaymentOption({ challenge: CHALLENGES[providerId](), pin }));
      expect(selected.rail.network, providerId).toBe(BASE_NETWORK);
      expect(selected.rail.asset.toLowerCase(), providerId).toBe(BASE_USDC_ADDRESS.toLowerCase());
    }
  });

  it("honours an explicit rail preference, so Base can be forced", () => {
    const baseOnly = PAYMENT_RAILS.filter((rail) => rail.id === "base-usdc");
    const pin = expectOk(pinFor("coinmarketcap"));
    const selected = expectOk(
      selectPaymentOption({
        challenge: CHALLENGES.coinmarketcap(),
        pin,
        railPreference: baseOnly,
      }),
    );
    expect(selected.rail.id).toBe("base-usdc");
    expect(fp.format(selected.amount)).toBe("0.01");
  });

  it("never selects a permit2 option, because that grants a standing allowance", () => {
    for (const providerId of ["coinmarketcap", "nansen"] as const) {
      const pin = expectOk(pinFor(providerId));
      const selected = expectOk(
        selectPaymentOption({ challenge: CHALLENGES[providerId](), pin }),
      );
      expect(selected.option.extra["assetTransferMethod"] ?? "eip3009", providerId).toBe("eip3009");
    }
  });

  it("reads each rail at its own decimals, so a cent never becomes ten thousand dollars", () => {
    // This is the trap the rail registry exists for. Base USDC carries six
    // decimals and the BSC stablecoins carry eighteen, and the same "one cent"
    // is written as 10000 on one rail and 10000000000000000 on the other.
    const gecko = expectOk(
      selectPaymentOption({
        challenge: CHALLENGES.coingecko(),
        pin: expectOk(pinFor("coingecko")),
      }),
    );
    expect(gecko.option.amount).toBe("10000");
    expect(gecko.rail.decimals).toBe(6);
    expect(fp.equals(gecko.amount, fp.parse("0.01"))).toBe(true);

    const cmc = expectOk(
      selectPaymentOption({
        challenge: CHALLENGES.coinmarketcap(),
        pin: expectOk(pinFor("coinmarketcap")),
      }),
    );
    expect(cmc.option.amount).toBe("10000000000000000");
    expect(cmc.rail.decimals).toBe(18);
    expect(fp.equals(cmc.amount, fp.parse("0.01"))).toBe(true);

    // Both are one cent. Read at the wrong scale, the BSC figure would be ten
    // billion dollars, and the per-call cap would be the only thing standing
    // between that and a signature.
    expect(fp.equals(gecko.amount, cmc.amount)).toBe(true);

    // And both read back as money. The rail's decimals are how the chain writes
    // the number down, not part of the price: without trimming, a five-cent
    // Nansen call reaches a WhatsApp receipt as "0.050000000000000000", and a
    // run that paid on both rails inherits eighteen decimals in its total.
    expect(fp.format(gecko.amount)).toBe("0.01");
    expect(fp.format(cmc.amount)).toBe("0.01");
    expect(fp.format(fp.add(gecko.amount, cmc.amount))).toBe("0.02");
  });
});

describe("refusing a challenge that should not be paid", () => {
  function withAccepts(
    challenge: PaymentRequired,
    accepts: PaymentRequirements[],
  ): PaymentRequired {
    return { ...challenge, accepts };
  }

  it("refuses when the recipient is not the pinned one", () => {
    // The attack this exists for: a tampered or hijacked 402 that keeps the
    // right price and swaps the address.
    const pin = expectOk(pinFor("coingecko"));
    const challenge = CHALLENGES.coingecko();
    const base = challenge.accepts.find((option) => option.network === BASE_NETWORK);
    if (base === undefined) {
      throw new Error("fixture no longer has a Base option");
    }
    const tampered = withAccepts(challenge, [
      { ...base, payTo: "0x000000000000000000000000000000000000dead" },
    ]);

    const refusal = expectRefusal(selectPaymentOption({ challenge: tampered, pin }));
    expect(refusal.code).toBe("X402_RECIPIENT_MISMATCH");
    expect(refusal.context?.["offered"]).toBe("0x000000000000000000000000000000000000dead");
  });

  it("refuses when every remaining option is permit2, on any chain", () => {
    // BSC USDC and USDT are permit2-only, so a challenge offering just those is
    // priced in assets Telt cannot sign a single-payment authorisation for.
    const pin = expectOk(pinFor("coinmarketcap"));
    const challenge = CHALLENGES.coinmarketcap();
    const permit2Only = withAccepts(
      challenge,
      challenge.accepts
        .filter((option) => option.extra["assetTransferMethod"] === "permit2-exact")
        .map((option) => ({ ...option })),
    );
    expect(permit2Only.accepts.length).toBeGreaterThan(0);
    expect(expectRefusal(selectPaymentOption({ challenge: permit2Only, pin })).code).toBe(
      "X402_ASSET_NOT_PINNED",
    );
  });

  it("stops on a bad recipient rather than quietly trying the next rail", () => {
    // A wrong address on the preferred rail means this challenge is not
    // trustworthy at all. Falling through to Base would pay a challenge that
    // has already shown it cannot be believed.
    const pin = expectOk(pinFor("coinmarketcap"));
    const challenge = CHALLENGES.coinmarketcap();
    const tampered = withAccepts(
      challenge,
      challenge.accepts.map((option) =>
        option.network === BSC_NETWORK
          ? { ...option, payTo: "0x000000000000000000000000000000000000dead" }
          : option,
      ),
    );
    const refusal = expectRefusal(selectPaymentOption({ challenge: tampered, pin }));
    expect(refusal.code).toBe("X402_RECIPIENT_MISMATCH");
    expect(refusal.context?.["rail"]).toBe("bsc-u");
  });

  it("refuses when the only Base option is permit2", () => {
    const pin = expectOk(pinFor("coingecko"));
    const challenge = CHALLENGES.coingecko();
    const base = challenge.accepts.find((option) => option.network === BASE_NETWORK);
    if (base === undefined) {
      throw new Error("fixture no longer has a Base option");
    }
    const permit2Only = withAccepts(challenge, [
      { ...base, extra: { ...base.extra, assetTransferMethod: "permit2-exact" } },
    ]);
    expect(expectRefusal(selectPaymentOption({ challenge: permit2Only, pin })).code).toBe(
      "X402_ASSET_NOT_PINNED",
    );
  });

  it("refuses a Base option in a token that is not USDC", () => {
    const pin = expectOk(pinFor("coingecko"));
    const challenge = CHALLENGES.coingecko();
    const base = challenge.accepts.find((option) => option.network === BASE_NETWORK);
    if (base === undefined) {
      throw new Error("fixture no longer has a Base option");
    }
    const wrongAsset = withAccepts(challenge, [
      { ...base, asset: "0x4200000000000000000000000000000000000006" },
    ]);
    expect(expectRefusal(selectPaymentOption({ challenge: wrongAsset, pin })).code).toBe(
      "X402_ASSET_NOT_PINNED",
    );
  });

  it("refuses an amount that is not an exact integer of atoms", () => {
    const pin = expectOk(pinFor("coingecko"));
    const challenge = CHALLENGES.coingecko();
    const base = challenge.accepts.find((option) => option.network === BASE_NETWORK);
    if (base === undefined) {
      throw new Error("fixture no longer has a Base option");
    }
    const fractional = withAccepts(challenge, [{ ...base, amount: "1.5e4" }]);
    expect(expectRefusal(selectPaymentOption({ challenge: fractional, pin })).code).toBe(
      "X402_NO_ACCEPTABLE_OPTION",
    );
  });

  it("refuses a challenge that offers nothing", () => {
    const pin = expectOk(pinFor("coingecko"));
    expect(
      expectRefusal(selectPaymentOption({ challenge: withAccepts(CHALLENGES.coingecko(), []), pin }))
        .code,
    ).toBe("X402_NO_ACCEPTABLE_OPTION");
  });

  it("refuses a provider it has no pin for", () => {
    expect(expectRefusal(pinFor("some-new-merchant")).code).toBe("X402_RECIPIENT_MISMATCH");
  });
});

describe("host pinning", () => {
  it("accepts the provider's own https host", () => {
    const pin = MERCHANT_PINS["coingecko"];
    if (pin === undefined) throw new Error("missing pin");
    const url = expectOk(
      assertHostMatchesPin("https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=ethereum", pin),
    );
    expect(url.hostname).toBe("pro-api.coingecko.com");
  });

  it("refuses a lookalike host", () => {
    const pin = MERCHANT_PINS["coingecko"];
    if (pin === undefined) throw new Error("missing pin");
    expect(
      expectRefusal(assertHostMatchesPin("https://pro-api.coingecko.com.evil.test/x", pin)).code,
    ).toBe("X402_RECIPIENT_MISMATCH");
  });

  it("refuses plain http, so a challenge cannot be read off the wire", () => {
    const pin = MERCHANT_PINS["coingecko"];
    if (pin === undefined) throw new Error("missing pin");
    expect(
      expectRefusal(assertHostMatchesPin("http://pro-api.coingecko.com/api/v3/x402/simple/price", pin))
        .code,
    ).toBe("X402_RECIPIENT_MISMATCH");
  });

  it("refuses something that is not a URL at all", () => {
    const pin = MERCHANT_PINS["coingecko"];
    if (pin === undefined) throw new Error("missing pin");
    expect(expectRefusal(assertHostMatchesPin("not a url", pin)).code).toBe(
      "X402_RECIPIENT_MISMATCH",
    );
  });
});

describe("building the quote a receipt is written from", () => {
  it("records the price, the recipient, and where the challenge was found", () => {
    const pin = expectOk(pinFor("nansen"));
    const selected = expectOk(selectPaymentOption({ challenge: CHALLENGES.nansen(), pin }));
    const quote = buildQuote({
      providerId: "nansen",
      endpointId: "nansen:smart-money/netflow",
      url: "https://api.nansen.ai/api/v1/smart-money/netflow",
      selected,
      source: "body",
    });

    expect(quote.providerId).toBe("nansen");
    expect(fp.format(quote.amount)).toBe("0.05");
    expect(quote.rail).toBe("bsc-u");
    expect(quote.assetName).toBe("United Stables");
    expect(quote.facilitator).toBe("Binance B402");
    expect(quote.network).toBe(BSC_NETWORK);
    expect(quote.challengeSource).toBe("body");
    // Nansen offers eight ways to pay. Three are rails Telt will sign for
    // (U and USD1 on BSC, USDC on Base) and it takes the first by preference.
    expect(quote.offeredOptions).toBe(8);
    expect(quote.acceptableOptions).toBe(3);
  });
});
