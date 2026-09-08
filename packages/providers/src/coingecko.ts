/**
 * CoinGecko, tier 1. One independent price for one cent.
 *
 * Bought when the venue price has nothing to corroborate it. The point is not a
 * better price than Binance's — it is a *second* price, from an operator with
 * no stake in the order, so a proposal never rests on one venue's opinion of
 * what an asset is worth.
 *
 * Both the request parameters and the response shape below come from the
 * `extensions.bazaar` block inside CoinGecko's own live 402 challenge, saved at
 * `fixtures/x402/live-quotes/coingecko-simple-price-402.json`. That block
 * carries a JSON Schema for the query and a worked example of the answer, which
 * makes it a better source than the published docs: it is what the endpoint
 * being paid actually promises.
 *
 * `precision=full` is requested deliberately. The default rounds to two
 * decimals, which is harmless for ETH and destroys a low-unit-price token
 * outright.
 */

import { ok, refuse } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";
import { decimalFromJson, positiveDecimalFromJson } from "./decimal.js";

const ENDPOINT = "https://pro-api.coingecko.com/api/v3/x402/simple/price";

export const coingeckoPriceAdapter: ProviderAdapter = {
  provider: "coingecko",
  stepId: "coingecko.price",
  capability: "market.price",
  endpointId: "coingecko:simple/price",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const coinId = context.instrument.coingeckoId;
    if (coinId === null) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `No verified CoinGecko id for ${context.instrument.symbol}, so Telt will not guess one and buy a price for the wrong asset.`,
        { provider: "coingecko", symbol: context.instrument.symbol },
      );
    }
    const url = new URL(ENDPOINT);
    url.searchParams.set("ids", coinId);
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_24hr_change", "true");
    url.searchParams.set("include_last_updated_at", "true");
    url.searchParams.set("precision", "full");
    return ok({
      providerId: "coingecko",
      endpointId: "coingecko:simple/price",
      url: url.toString(),
      method: "GET",
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }

    // Keyed by the coin id that was asked for. Reading whatever single key came
    // back instead would hand an upstream mix-up straight into a price.
    const coinId = context.instrument.coingeckoId;
    if (coinId === null) {
      return null;
    }
    const entry = (body as Record<string, unknown>)[coinId];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }

    const fields = entry as Record<string, unknown>;
    const price = positiveDecimalFromJson(fields["usd"]);
    if (price === null) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      priceUsd: price,
      coinId: context.instrument.coingeckoId,
    };

    const change = decimalFromJson(fields["usd_24h_change"]);
    if (change !== null) {
      normalized["change24hPct"] = change;
    }
    const updatedAt = fields["last_updated_at"];
    if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
      // CoinGecko reports this in seconds. Kept as sent, named so.
      normalized["lastUpdatedAtSeconds"] = updatedAt;
    }

    return Object.freeze(normalized);
  },
};
