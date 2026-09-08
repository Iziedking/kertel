/**
 * CoinMarketCap, tier 1. The tiebreak.
 *
 * The planner buys this one of two ways: as the single independent price when
 * CoinGecko is unhealthy, or as a third opinion when Binance and CoinGecko
 * disagree by more than a hundred basis points. In the second case it is
 * genuinely deciding something — which of the two is the outlier — which is why
 * it is worth another cent rather than an escalation to a dearer source.
 *
 * **Asked by id, not by ticker.** CoinMarketCap's own x402 reference queries
 * `?id=1` and answers `{"status":{...},"data":{"1":{...}}}`, keyed by that id.
 * A ticker is ambiguous — several listed assets answer to `ETH` — and asking by
 * one means the reply has to be disambiguated on the way back, at exactly the
 * moment a wrong guess turns into a price an order is sized from. An id removes
 * the question from both ends: Telt asks for 1027, reads `data["1027"]`, and
 * checks the entry's own `id` and `symbol` agree before believing any of it.
 *
 * One caveat kept honest, because it is the only shape in this package not
 * confirmed against a real answer. CoinMarketCap's x402 challenge carries no
 * `extensions.bazaar` block — re-checked live on 2026-09-07, the keys are
 * exactly `x402Version`, `resource`, `accepts` and `error` — so unlike CoinGecko
 * and Nansen it does not publish an output schema with the challenge, and
 * nobody has yet paid the cent it takes to see one. The envelope and the keying
 * below come from CoinMarketCap's published x402 reference; the object-or-array
 * question is the part their docs answer inconsistently across versions, so
 * both are accepted and anything else returns null.
 *
 * The worst case of that residual uncertainty is a wasted cent and a run that
 * routes around this provider — never a price invented from a field that
 * happened to parse. When the first live paid call lands, check it against this
 * and pin the shape down to the one that actually arrived.
 */

import { ok, refuse } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";
import { positiveDecimalFromJson } from "./decimal.js";

const ENDPOINT = "https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest";

type AssetEntry = {
  readonly id?: unknown;
  readonly symbol?: unknown;
  readonly quote?: unknown;
};

/** `data[id]` is either the asset object or a one-element array of them. */
function assetFrom(data: unknown, key: string): AssetEntry | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];

  if (Array.isArray(value)) {
    // More than one entry under a numeric id would mean the id is not the
    // unique key CoinMarketCap documents it to be. Picking one would be
    // guessing about the very thing that went wrong.
    if (value.length !== 1) {
      return null;
    }
    const first = value[0];
    return typeof first === "object" && first !== null ? (first as AssetEntry) : null;
  }

  if (typeof value === "object" && value !== null) {
    return value as AssetEntry;
  }
  return null;
}

export const coinmarketcapPriceAdapter: ProviderAdapter = {
  provider: "coinmarketcap",
  stepId: "coinmarketcap.price",
  capability: "market.price",
  endpointId: "coinmarketcap:quotes/latest",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const id = context.instrument.coinmarketcapId;
    if (id === null) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `No verified CoinMarketCap id for ${context.instrument.symbol}. A ticker is ambiguous there, so Telt will not guess one.`,
        { provider: "coinmarketcap", symbol: context.instrument.symbol },
      );
    }
    const url = new URL(ENDPOINT);
    url.searchParams.set("id", String(id));
    url.searchParams.set("convert", "USD");
    return ok({
      providerId: "coinmarketcap",
      endpointId: "coinmarketcap:quotes/latest",
      url: url.toString(),
      method: "GET",
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const envelope = body as { readonly status?: unknown; readonly data?: unknown };

    // A non-zero error code means the payload is an error report that happens
    // to have a `data` key. Reading a price out of it would be reading noise.
    if (typeof envelope.status === "object" && envelope.status !== null) {
      const code = (envelope.status as Record<string, unknown>)["error_code"];
      if (typeof code === "number" && code !== 0) {
        return null;
      }
    }

    const id = context.instrument.coinmarketcapId;
    if (id === null) {
      return null;
    }
    const asset = assetFrom(envelope.data, String(id));
    if (asset === null) {
      return null;
    }

    // Both identifiers are echoed inside the entry. Either one disagreeing with
    // what was asked for means the payload is not describing this asset, and no
    // field in it can be trusted.
    if (typeof asset.id === "number" && asset.id !== id) {
      return null;
    }
    if (
      typeof asset.symbol === "string" &&
      asset.symbol !== context.instrument.coinmarketcapSymbol
    ) {
      return null;
    }

    if (typeof asset.quote !== "object" || asset.quote === null) {
      return null;
    }
    const usd = (asset.quote as Record<string, unknown>)["USD"];
    if (typeof usd !== "object" || usd === null) {
      return null;
    }

    const price = positiveDecimalFromJson((usd as Record<string, unknown>)["price"]);
    if (price === null) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      priceUsd: price,
      cmcId: id,
      ticker: context.instrument.coinmarketcapSymbol,
    };

    const lastUpdated = (usd as Record<string, unknown>)["last_updated"];
    if (typeof lastUpdated === "string" && lastUpdated !== "") {
      normalized["lastUpdated"] = lastUpdated;
    }

    return Object.freeze(normalized);
  },
};
