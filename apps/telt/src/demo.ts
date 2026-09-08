import * as fp from "@telt/core/money";
import { formatInstant } from "@telt/core/domain";
import type { MarketSnapshot, Symbol_ } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { Verdict } from "@telt/core/autonomy";

import type { BinanceClient } from "./infra/binance.js";
import type { ModelClient } from "./infra/model.js";
import type { PublicResearchResult } from "./demo-research.js";

const SUPPORTED_ASSETS = ["BTC", "ETH", "BNB", "SOL"] as const;
const QUESTION_LIMIT = 500;
const CACHE_MS = 60_000;

export type DemoResponse = {
  readonly ok: true;
  readonly question: string;
  readonly symbol: string;
  readonly market: {
    readonly bestBid: string;
    readonly bestAsk: string;
    readonly averagePrice: string | null;
    readonly spreadBps: number;
    readonly observedAt: string;
    readonly source: string;
  };
  readonly research: PublicResearchResult;
  readonly trace: readonly {
    readonly id: string;
    readonly status: "live" | "unavailable";
    readonly detail: string;
  }[];
  readonly verdict: Verdict;
  readonly model: string;
  readonly cached: boolean;
  readonly boundaries: readonly string[];
};

export type DemoFailure = {
  readonly ok: false;
  readonly status: 400 | 429 | 502 | 503;
  readonly code: string;
  readonly error: string;
};

type DemoDeps = {
  readonly binance: Pick<BinanceClient, "market">;
  readonly model: ModelClient;
  readonly modelName: string;
  readonly dailyLimit: number;
  readonly perMinuteLimit: number;
  readonly research?: (symbol: Symbol_) => Promise<PublicResearchResult>;
  readonly now?: () => number;
};

type Cached = { readonly expiresAt: number; readonly value: DemoResponse };

export type DemoService = {
  analyze(message: unknown, client: string): Promise<DemoResponse | DemoFailure>;
};

export function demoSymbol(question: string): Symbol_ {
  const upper = question.toUpperCase();
  for (const asset of SUPPORTED_ASSETS) {
    if (new RegExp(`\\b${asset}(?:USDT)?\\b`).test(upper)) {
      return `${asset}USDT` as Symbol_;
    }
  }
  return "ETHUSDT" as Symbol_;
}

function questionOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 && value.length <= QUESTION_LIMIT ? value : null;
}

function evidence(market: MarketSnapshot): string {
  const spread = fp.subtract(market.bestAsk, market.bestBid);
  const spreadBps = fp.isPositive(market.bestAsk)
    ? Number(fp.multiply(fp.divide(spread, market.bestAsk, 8, "floor"), fp.parse("10000")).atoms) /
      10 ** fp.multiply(fp.divide(spread, market.bestAsk, 8, "floor"), fp.parse("10000")).scale
    : 0;
  return [
    "LIVE BINANCE MARKET SNAPSHOT",
    `Symbol: ${market.symbol}`,
    `Best bid: ${fp.format(market.bestBid)} USDT`,
    `Best ask: ${fp.format(market.bestAsk)} USDT`,
    `Bid/ask spread: ${spreadBps.toFixed(2)} bps`,
    `Five-minute average: ${market.averagePrice === null ? "unavailable" : `${fp.format(market.averagePrice)} USDT`}`,
    `Observed at: ${formatInstant(market.observedAt)}`,
    `Source: ${market.source}`,
    "Coverage limit: no news, flows, fundamentals, portfolio, or position data was supplied.",
    "No order will be placed from this answer.",
  ].join("\n");
}

function researchEvidence(research: PublicResearchResult): string {
  if (research.status === "unavailable") {
    return [
      "COINGECKO PUBLIC RESEARCH",
      "Status: unavailable",
      `Reason: ${research.reason ?? "No reason supplied."}`,
      "This corroboration source did not answer. Do not infer a price or market edge from its absence.",
    ].join("\n");
  }
  return [
    "COINGECKO PUBLIC RESEARCH",
    `Price: ${research.priceUsd ?? "unavailable"} USD`,
    `24-hour change: ${research.change24hPct === null ? "unavailable" : `${research.change24hPct}%`}`,
    `Observed at: ${research.observedAt}`,
    `Source: ${research.source}`,
    "This is free read-only price corroboration, not smart-money flow, news, fundamentals, or portfolio data.",
  ].join("\n");
}

function fallbackResearch(now: () => number): PublicResearchResult {
  return {
    status: "unavailable",
    provider: "coingecko",
    source: "coingecko:simple/price",
    priceUsd: null,
    change24hPct: null,
    observedAt: new Date(now()).toISOString(),
    reason: "Public research was not configured on this server.",
  };
}

function marketView(market: MarketSnapshot): DemoResponse["market"] {
  const spread = fp.subtract(market.bestAsk, market.bestBid);
  const ratio = fp.isPositive(market.bestAsk)
    ? fp.multiply(fp.divide(spread, market.bestAsk, 8, "floor"), fp.parse("10000"))
    : fp.parse("0");
  return {
    bestBid: fp.format(market.bestBid),
    bestAsk: fp.format(market.bestAsk),
    averagePrice: market.averagePrice === null ? null : fp.format(market.averagePrice),
    spreadBps: Number(ratio.atoms) / 10 ** ratio.scale,
    observedAt: formatInstant(market.observedAt),
    source: market.source,
  };
}

export function createDemoService(deps: DemoDeps): DemoService {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Cached>();
  const perClient = new Map<string, number[]>();
  let day = "";
  let callsToday = 0;

  return {
    async analyze(raw, client) {
      const question = questionOf(raw);
      if (question === null) {
        return { ok: false, status: 400, code: "INVALID_QUESTION", error: `Ask a question between 1 and ${String(QUESTION_LIMIT)} characters.` };
      }
      if (!deps.model.available) {
        return { ok: false, status: 503, code: "MODEL_UNAVAILABLE", error: "Telt's reasoning model is not configured on this server." };
      }

      const at = now();
      const minute = (perClient.get(client) ?? []).filter((seen) => seen > at - 60_000);
      if (minute.length >= deps.perMinuteLimit) {
        return { ok: false, status: 429, code: "RATE_LIMITED", error: "This demo has reached its short request limit. Wait one minute and try again." };
      }
      minute.push(at);
      perClient.set(client, minute);

      const symbol = demoSymbol(question);
      const cacheKey = `${symbol}\n${question.toLowerCase().replace(/\s+/g, " ")}`;
      const saved = cache.get(cacheKey);
      if (saved !== undefined && saved.expiresAt > at) {
        return { ...saved.value, cached: true };
      }

      const utcDay = new Date(at).toISOString().slice(0, 10);
      if (utcDay !== day) {
        day = utcDay;
        callsToday = 0;
      }
      if (deps.dailyLimit <= 0 || callsToday >= deps.dailyLimit) {
        return { ok: false, status: 429, code: "DAILY_LIMIT", error: "The live model demo has reached today's call limit. The MCP endpoint is still available." };
      }

      const [market, research] = await Promise.all([
        deps.binance.market(symbol),
        deps.research === undefined ? Promise.resolve(fallbackResearch(now)) : deps.research(symbol),
      ]);
      if (!market.ok) {
        return { ok: false, status: 502, code: market.error.code, error: market.error.detail };
      }

      callsToday += 1;
      const judged: Result<Verdict, Refusal> = await deps.model.judge({
        symbol,
        evidence: `${evidence(market.value)}\n\n${researchEvidence(research)}`,
      });
      if (!judged.ok) {
        return { ok: false, status: 502, code: judged.error.code, error: judged.error.detail };
      }

      const value: DemoResponse = {
        ok: true,
        question,
        symbol,
        market: marketView(market.value),
        research,
        trace: [
          { id: "binance.market", status: "live", detail: "bookTicker + avgPrice" },
          {
            id: "coingecko.public-price",
            status: research.status,
            detail: research.status === "live" ? "free price and 24-hour change" : research.reason ?? "unavailable",
          },
          { id: "claude.verdict", status: "live", detail: "validated Verdict JSON" },
        ],
        verdict: judged.value,
        model: deps.modelName,
        cached: false,
        boundaries: [
          "Public Binance market data only",
          "Free CoinGecko price corroboration only",
          "No account or portfolio access",
          "No paid x402 research and no order execution",
        ],
      };
      cache.set(cacheKey, { expiresAt: at + CACHE_MS, value });
      return value;
    },
  };
}
