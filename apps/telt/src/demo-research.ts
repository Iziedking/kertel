import type { Symbol_ } from "@telt/core/domain";

const ENDPOINT = "https://api.coingecko.com/api/v3/simple/price";
const TIMEOUT_MS = 8_000;

const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  BNBUSDT: "binancecoin",
  SOLUSDT: "solana",
};

export type PublicResearchResult = {
  readonly status: "live" | "unavailable";
  readonly provider: "coingecko";
  readonly source: string;
  readonly priceUsd: string | null;
  readonly change24hPct: string | null;
  readonly observedAt: string;
  readonly reason: string | null;
};

export type PublicResearchConfig = {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => number;
};

function unavailable(reason: string, now: () => number): PublicResearchResult {
  return {
    status: "unavailable",
    provider: "coingecko",
    source: "coingecko:simple/price",
    priceUsd: null,
    change24hPct: null,
    observedAt: new Date(now()).toISOString(),
    reason,
  };
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A free corroboration read for the public demo. This deliberately does not
 * use Telt's paid x402 provider rail: an anonymous visitor must never spend
 * the operator's wallet. CoinGecko documents this keyless endpoint at
 * https://docs.coingecko.com/reference/simple-price.
 */
export function createPublicResearchClient(config: PublicResearchConfig = {}) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const now = config.now ?? Date.now;

  return async function research(symbol: Symbol_): Promise<PublicResearchResult> {
    const id = COINGECKO_IDS[symbol];
    if (id === undefined) return unavailable("No public research mapping exists for this asset.", now);

    const query = new URLSearchParams({
      ids: id,
      vs_currencies: "usd",
      include_24hr_change: "true",
      include_last_updated_at: "true",
      precision: "full",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetchImpl(`${ENDPOINT}?${query.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return unavailable(`CoinGecko answered ${String(response.status)}.`, now);

      const body = (await response.json()) as unknown;
      if (typeof body !== "object" || body === null) return unavailable("CoinGecko returned no usable price object.", now);
      const asset = (body as Record<string, unknown>)[id];
      if (typeof asset !== "object" || asset === null) return unavailable("CoinGecko returned no price for this asset.", now);
      const record = asset as Record<string, unknown>;
      const price = numeric(record["usd"]);
      if (price === null || price <= 0) return unavailable("CoinGecko returned an unreadable price.", now);
      const change = numeric(record["usd_24h_change"]);
      const observedSeconds = numeric(record["last_updated_at"]);
      const observedAt = observedSeconds !== null && observedSeconds > 0
        ? new Date(observedSeconds * 1000).toISOString()
        : new Date(now()).toISOString();

      return {
        status: "live",
        provider: "coingecko",
        source: "coingecko:simple/price",
        priceUsd: price.toString(),
        change24hPct: change === null ? null : change.toFixed(4),
        observedAt,
        reason: null,
      };
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      return unavailable(aborted ? "CoinGecko did not answer before the read window closed." : "CoinGecko could not be reached.", now);
    } finally {
      clearTimeout(timer);
    }
  };
}
