/**
 * OpenPulse, tier 2. The half of a thesis that is not a price.
 *
 * Every other paid source Telt buys answers "what is it worth". None of them
 * answer "what is happening to it", and a trader who only ever reads price is
 * reading the one number that has already moved. These three endpoints are the
 * other half:
 *
 * - **Sentiment** — what is being said, aggregated. Cheap, and the fastest
 *   signal that something has changed about a token that the price has not
 *   caught up with yet.
 * - **Safety** — honeypot, mint authority, ownership. This one is not an edge,
 *   it is a floor: it exists to stop a trade rather than to justify one, which
 *   is why it is bought before conviction rather than after.
 * - **OHLCV** — the candles, so a technical read is measured rather than
 *   imagined. Telt does not draw trend lines; it reports range and where the
 *   current price sits in it, which is the part a model can actually reason
 *   over without inventing a pattern.
 *
 * Verified live on 2026-09-08. The catalogue at
 * `https://safety.openpulsechain.com/.well-known/x402` advertises 28 endpoints,
 * settling in USDC on Base through Coinbase's own CDP facilitator — the same
 * rail Telt already pays CoinGecko on — and every path below answered 402 with
 * a v2 challenge in the `payment-required` header, which is exactly the dialect
 * Telt's buyer speaks. No protocol work was needed, which is the only reason
 * this could be added safely in a day.
 *
 * **Only `safety` is wired into a recipe, and only because it was paid for.**
 * On 2026-09-08 a real payment was made to each of these. `safety` answered
 * with the payload the field names below are taken from. `sentiment` took the
 * money and answered 401, which is worse than useless: Telt treats a
 * signed-but-unconfirmed payment as X402_PAYMENT_UNKNOWN and engages the kill
 * switch, so wiring it would have stopped the agent on every research run. The
 * candles endpoint was never paid for at all.
 *
 * So the sentiment and candles adapters below are present and unwired. Pay for
 * one, look at what arrives, correct the field names, and only then add its
 * step back to the recipe — in that order. That order is the whole lesson of
 * this file: a catalogue entry is a claim, and a 402 only proves an endpoint
 * will take your money.
 */

import { ok, refuse } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";
import { positiveDecimalFromJson } from "./decimal.js";

const BASE = "https://safety.openpulsechain.com";

/** Read a number from any of several plausible names, or null. */
function numberFrom(source: unknown, names: readonly string[]): number | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  }
  return null;
}

function stringFrom(source: unknown, names: readonly string[]): string | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** The payload, whether it arrives bare or wrapped in `data`/`result`. */
function unwrap(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["data", "result", "payload"]) {
    const inner = record[key];
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return record;
}

/**
 * What is being said about a token.
 *
 * Asked by ticker, which is what this endpoint takes, and which is safe here in
 * a way it is not for a price: a sentiment reading attached to the wrong asset
 * of the same name is misleading, but it cannot size an order. The receipt names
 * the ticker asked for so a reader can judge that themselves.
 */
export const openpulseSentimentAdapter: ProviderAdapter = {
  provider: "openpulse",
  stepId: "openpulse.sentiment",
  capability: "market.sentiment",
  endpointId: "openpulse:sentiment",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const ticker = context.instrument.baseAsset;
    if (ticker === "") {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `Telt has no base asset for ${context.instrument.symbol}, so it cannot ask about sentiment.`,
        { provider: "openpulse", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "openpulse",
      endpointId: "openpulse:sentiment",
      url: `${BASE}/api/v1/sentiment/${encodeURIComponent(ticker)}`,
      method: "GET",
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    const data = unwrap(body);
    if (data === null) return null;

    // A score under any of the names this kind of API tends to use. Without one
    // there is nothing here worth reporting, and a receipt saying "unreadable"
    // is more useful than a mood invented from a stray field.
    const score = numberFrom(data, ["score", "sentiment", "sentimentScore", "value", "net"]);
    const label = stringFrom(data, ["label", "sentiment_label", "classification", "mood"]);
    if (score === null && label === null) return null;

    const normalized: Record<string, unknown> = { ticker: context.instrument.baseAsset };
    if (score !== null) normalized["sentimentScore"] = score;
    if (label !== null) normalized["sentimentLabel"] = label;

    const mentions = numberFrom(data, ["mentions", "count", "volume", "posts"]);
    if (mentions !== null) normalized["mentions"] = mentions;

    const window = stringFrom(data, ["window", "period", "timeframe"]);
    if (window !== null) normalized["window"] = window;

    return Object.freeze(normalized);
  },
};

/**
 * Whether the token is safe to touch at all.
 *
 * Bought before conviction rather than after, because it can only ever stop a
 * trade. A honeypot with excellent sentiment is still a honeypot, and finding
 * that out after paying for the expensive flow data is the wrong order.
 *
 * Asked by contract address, never by ticker: a safety verdict is a statement
 * about one specific contract, and attaching it to the wrong one is the single
 * most dangerous mistake this whole module could make.
 */
export const openpulseSafetyAdapter: ProviderAdapter = {
  provider: "openpulse",
  stepId: "openpulse.safety",
  capability: "onchain.safety",
  endpointId: "openpulse:token/safety",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const address = context.instrument.nansenTokenAddresses[0];
    if (address === undefined) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `No verified contract address for ${context.instrument.symbol}, so Telt will not ask for a safety verdict on a contract it cannot name.`,
        { provider: "openpulse", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "openpulse",
      endpointId: "openpulse:token/safety",
      url: `${BASE}/api/v1/token/${address}/safety`,
      method: "GET",
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    const data = unwrap(body);
    if (data === null) return null;

    const address = context.instrument.nansenTokenAddresses[0];
    if (address === undefined) return null;

    // The token the provider says it looked at must be the one asked about.
    // Everything below is a statement about one specific contract, and reading
    // a verdict for a different one is the worst mistake this module could make.
    const answered = stringFrom(data, ["token_address"]);
    if (answered !== null && answered.toLowerCase() !== address.toLowerCase()) {
      return null;
    }

    const score = numberFrom(data, ["score"]);
    const grade = stringFrom(data, ["grade"]);
    if (score === null && grade === null) return null;

    const normalized: Record<string, unknown> = { contract: address };
    if (score !== null) normalized["safetyScore"] = score;
    if (grade !== null) normalized["grade"] = grade;

    // The provider's own plain-language findings, which are more useful to a
    // reasoning layer than any single number it could be reduced to.
    const risks = data["risks"];
    if (Array.isArray(risks)) {
      const stated = risks.filter((risk): risk is string => typeof risk === "string" && risk.trim() !== "");
      if (stated.length > 0) normalized["risks"] = stated;
    }

    // Tri-state, and the distinction matters more here than anywhere else in
    // Telt. This provider answers `is_honeypot: null` when its simulation could
    // not run, and a null read as false is the difference between "we checked
    // and it is safe" and "we could not check". Only a real boolean is carried.
    for (const [key, name] of [
      ["isHoneypot", "is_honeypot"],
      ["hasMint", "has_mint"],
      ["hasBlacklist", "has_blacklist"],
      ["ownershipRenounced", "ownership_renounced"],
      ["verifiedSource", "is_verified"],
      ["isProxy", "is_proxy"],
      ["hasLiquidityPool", "has_lp"],
    ] as const) {
      const value = data[name];
      if (typeof value === "boolean") normalized[key] = value;
    }

    // The figures a model can actually reason with. A token with no liquidity
    // and no holders is untradeable whatever its score says, and saying that
    // out loud beats a grade nobody can interrogate.
    for (const [key, name] of [
      ["liquidityUsd", "total_liquidity_usd"],
      ["pairCount", "pair_count"],
      ["holderCount", "holder_count"],
      ["top10Pct", "top10_pct"],
      ["top1Pct", "top1_pct"],
      ["ageDays", "age_days"],
      ["buyTaxPct", "buy_tax_pct"],
      ["sellTaxPct", "sell_tax_pct"],
    ] as const) {
      const value = numberFrom(data, [name]);
      if (value !== null) normalized[key] = value;
    }

    return Object.freeze(normalized);
  },
};

/**
 * The candles, so a technical read is measured rather than imagined.
 *
 * Telt deliberately does not compute an opinion here. It reports the high, the
 * low, the last, and where the last sits between them as a percentage — facts a
 * model can reason over. Anything more (a trend line, a pattern name, a
 * "breakout") would be Telt inventing a view and passing it off as data, which
 * is precisely what every other line of this codebase refuses to do.
 */
export const openpulseCandlesAdapter: ProviderAdapter = {
  provider: "openpulse",
  stepId: "openpulse.candles",
  capability: "market.technical",
  endpointId: "openpulse:token/ohlcv",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const address = context.instrument.nansenTokenAddresses[0];
    if (address === undefined) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `No verified contract address for ${context.instrument.symbol}, so Telt cannot ask for its candles.`,
        { provider: "openpulse", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "openpulse",
      endpointId: "openpulse:token/ohlcv",
      url: `${BASE}/api/v1/token/${address}/ohlcv`,
      method: "GET",
    });
  },

  normalize(body: unknown): Normalized | null {
    const data = unwrap(body);
    if (data === null) return null;

    // Either a bare array of candles or an object holding one.
    const candles = Array.isArray(body)
      ? body
      : Array.isArray(data["candles"])
        ? (data["candles"] as unknown[])
        : Array.isArray(data["ohlcv"])
          ? (data["ohlcv"] as unknown[])
          : null;

    if (candles === null || candles.length === 0) return null;

    let high: number | null = null;
    let low: number | null = null;
    let last: number | null = null;

    for (const candle of candles) {
      // Both shapes seen in the wild: an object, or [t, o, h, l, c, v].
      const h = Array.isArray(candle)
        ? typeof candle[2] === "number"
          ? candle[2]
          : null
        : numberFrom(candle, ["high", "h"]);
      const l = Array.isArray(candle)
        ? typeof candle[3] === "number"
          ? candle[3]
          : null
        : numberFrom(candle, ["low", "l"]);
      const c = Array.isArray(candle)
        ? typeof candle[4] === "number"
          ? candle[4]
          : null
        : numberFrom(candle, ["close", "c"]);

      if (h !== null && (high === null || h > high)) high = h;
      if (l !== null && (low === null || l < low)) low = l;
      if (c !== null) last = c;
    }

    if (high === null || low === null || last === null || !(high > 0) || !(low > 0)) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      candles: candles.length,
      high: String(high),
      low: String(low),
      last: String(last),
    };

    // Where the last price sits in the range, 0 at the low and 10000 at the
    // high. A single honest number instead of a narrative.
    if (high > low) {
      normalized["positionInRangeBps"] = Math.round(((last - low) / (high - low)) * 10_000);
    }

    const price = positiveDecimalFromJson(String(last));
    if (price !== null) normalized["lastParsed"] = String(last);

    return Object.freeze(normalized);
  },
};
