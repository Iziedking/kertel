/**
 * The exchange. Free market data unsigned, orders HMAC-signed.
 *
 * **This is the fallback rail.** Kertel prefers Binance Agent OS, in
 * `agentos.ts`, because orders placed there land in the Agentic sub-account,
 * which has no withdrawal scope to grant at all. This client exists for the
 * case that rail cannot cover: the Agent OS token lasts thirty days and cannot
 * refresh itself, so a machine whose token has lapsed and whose operator has
 * not signed in again still needs a way to manage open positions.
 *
 * An API key created with Spot trading enabled and withdrawals disabled is the
 * smallest authority that can do that job. Both clients implement the same
 * interface and share the same parsers, so a user sees one vocabulary of
 * refusals regardless of which rail carried the order.
 *
 * Three rules in here matter more than the rest.
 *
 * **A timeout on an order is never a failure.** `POST /api/v3/order` that does
 * not answer may have placed the order. Reporting that as rejected is how a
 * system tells a user nothing happened when their money already moved, or
 * places the same order twice on retry. It returns `EXECUTION_RESULT_UNKNOWN`
 * and the caller must reconcile before doing anything else.
 *
 * **Every order carries a client order id derived from the proposal hash.** The
 * same proposal cannot be sent twice, because the second attempt collides on an
 * id the exchange already knows.
 *
 * **The secret never leaves this file.** It is used to sign and is not stored on
 * the returned object, not logged, and not included in any error.
 */

import { createHmac } from "node:crypto";

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { instant, ok, refuse } from "@kertel/core/domain";
import type {
  AccountSnapshot,
  ExecutionStatus,
  MarketSnapshot,
  OrderSide,
  Refusal,
  Result,
  SymbolFilters,
  Symbol_,
} from "@kertel/core/domain";

const DEFAULT_BASE_URL = "https://api.binance.com";
const MARKET_TIMEOUT_MS = 8_000;
/** Orders get longer: giving up early on a request that may have placed one is the worst outcome. */
const ORDER_TIMEOUT_MS = 20_000;
const RECV_WINDOW_MS = 5_000;

export type PlacedOrder = {
  readonly exchangeOrderRef: string;
  readonly clientOrderId: string;
  readonly status: ExecutionStatus;
  readonly filledQuantity: FixedPoint;
  readonly averagePrice: FixedPoint | null;
  readonly feePaid: FixedPoint | null;
  readonly raw: unknown;
};

export type BinanceClient = {
  /** Whether an order can be placed at all. False means market data only. */
  readonly credentialed: boolean;
  filters(symbol: Symbol_): Promise<Result<SymbolFilters, Refusal>>;
  market(symbol: Symbol_): Promise<Result<MarketSnapshot, Refusal>>;
  account(): Promise<Result<AccountSnapshot, Refusal>>;
  placeMarketOrder(input: {
    readonly symbol: Symbol_;
    readonly side: OrderSide;
    readonly quantity: FixedPoint;
    readonly clientOrderId: string;
  }): Promise<Result<PlacedOrder, Refusal>>;
  findOrder(symbol: Symbol_, clientOrderId: string): Promise<Result<PlacedOrder | null, Refusal>>;
};

export type BinanceConfig = {
  readonly apiKey?: string | undefined;
  readonly apiSecret?: string | undefined;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
};

/**
 * Binance's own id charset is narrower than a hex digest is long.
 *
 * `^[\.A-Z\:/a-z0-9_-]{1,36}$`, so the derived idempotency key is prefixed and
 * truncated. Thirty hex characters is 120 bits, which is not a collision anyone
 * will hit, and the prefix makes Kertel's orders identifiable in the exchange's
 * own order list.
 */
export function clientOrderIdFrom(idempotencyKey: string): string {
  const cleaned = idempotencyKey.replace(/[^A-Za-z0-9]/g, "");
  return `kertel${cleaned.slice(0, 30)}`;
}

export type FilterEntry = { readonly filterType?: unknown } & Record<string, unknown>;

function filterOf(filters: readonly FilterEntry[], type: string): FilterEntry | undefined {
  return filters.find((entry) => entry["filterType"] === type);
}

function decimalField(entry: FilterEntry | undefined, key: string): FixedPoint | null {
  if (entry === undefined) {
    return null;
  }
  const raw = entry[key];
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw)) {
    return null;
  }
  return fp.parse(raw);
}

/**
 * Map an exchange error onto a refusal the user can act on.
 *
 * The mapping is deliberately narrow. An unrecognised code becomes
 * `EXCHANGE_REJECTED` with the exchange's own message attached, rather than
 * being guessed at — a wrong guess here tells the user to fix something that is
 * not the problem.
 */
export function refusalForCode(code: number, message: string): Refusal {
  switch (code) {
    case -2010:
    case -1013:
      // -1013 is a filter failure; the message names which filter.
      return refuse(
        message.includes("NOTIONAL") || message.includes("LOT_SIZE")
          ? "NOTIONAL_BELOW_EXCHANGE_MINIMUM"
          : "EXCHANGE_REJECTED",
        `The exchange rejected the order: ${message}`,
        { code },
      ).error;
    case -2019:
      return refuse("INSUFFICIENT_BALANCE", `The account has insufficient margin: ${message}`, {
        code,
      }).error;
    case -1021:
      return refuse(
        "PROVIDER_UNAVAILABLE",
        "The exchange rejected the request timestamp; this machine's clock is out of sync with Binance.",
        { code },
      ).error;
    case -2015:
    case -2014:
      return refuse(
        "EXECUTION_ADAPTER_UNAVAILABLE",
        "Binance rejected the API key. Check that it is valid, enabled for Spot trading, and permitted from this IP.",
        { code },
      ).error;
    case -2013:
      return refuse("EXCHANGE_REJECTED", "The exchange does not know that order.", { code }).error;
    default:
      return refuse("EXCHANGE_REJECTED", `The exchange rejected the order: ${message}`, { code })
        .error;
  }
}

function statusFrom(raw: unknown): ExecutionStatus {
  switch (raw) {
    case "NEW":
    case "PENDING_NEW":
      return "accepted";
    case "PARTIALLY_FILLED":
      return "partial";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "PENDING_CANCEL":
      return "canceled";
    case "REJECTED":
      return "rejected";
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "canceled";
    default:
      return "unknown";
  }
}

export type OrderResponse = {
  readonly orderId?: unknown;
  readonly clientOrderId?: unknown;
  readonly status?: unknown;
  readonly executedQty?: unknown;
  readonly cummulativeQuoteQty?: unknown;
  readonly fills?: unknown;
};

export function parseOrder(body: OrderResponse): PlacedOrder {
  const executed = typeof body.executedQty === "string" ? fp.parse(body.executedQty) : fp.parse("0");
  const quote =
    typeof body.cummulativeQuoteQty === "string" ? fp.parse(body.cummulativeQuoteQty) : null;

  // The average fill price is derived, not reported. Dividing the quote spent by
  // the base filled is the only figure that reflects what actually happened
  // across every fill.
  const averagePrice =
    quote !== null && fp.isPositive(executed) ? fp.divide(quote, executed, 8, "floor") : null;

  let feePaid: FixedPoint | null = null;
  if (Array.isArray(body.fills)) {
    let total = fp.parse("0.00000000");
    let sawFee = false;
    for (const fill of body.fills) {
      if (typeof fill === "object" && fill !== null) {
        const commission = (fill as Record<string, unknown>)["commission"];
        if (typeof commission === "string" && /^\d+(\.\d+)?$/.test(commission)) {
          total = fp.add(total, fp.parse(commission));
          sawFee = true;
        }
      }
    }
    feePaid = sawFee ? total : null;
  }

  return {
    exchangeOrderRef: String(body.orderId ?? ""),
    clientOrderId: String(body.clientOrderId ?? ""),
    status: statusFrom(body.status),
    filledQuantity: executed,
    averagePrice,
    feePaid,
    raw: body,
  };
}

/** Turn an `exchangeInfo` payload into the filters the proposal gate needs. */
export function parseExchangeInfo(
  body: unknown,
  symbol: Symbol_,
): Result<SymbolFilters, Refusal> {
  const symbols = (body as { symbols?: unknown }).symbols;
  const entry = Array.isArray(symbols) ? symbols[0] : undefined;
  if (typeof entry !== "object" || entry === null) {
    return refuse("PROVIDER_UNAVAILABLE", `Binance published no trading rules for ${symbol}.`);
  }
  const record = entry as Record<string, unknown>;
  if (record["status"] !== "TRADING") {
    return refuse(
      "SYMBOL_NOT_ALLOWED",
      `${symbol} is not currently trading on Binance (status ${String(record["status"])}).`,
    );
  }

  const list = Array.isArray(record["filters"]) ? (record["filters"] as FilterEntry[]) : [];
  const price = filterOf(list, "PRICE_FILTER");
  const lot = filterOf(list, "LOT_SIZE");
  const marketLot = filterOf(list, "MARKET_LOT_SIZE");
  const notional = filterOf(list, "NOTIONAL");

  const tickSize = decimalField(price, "tickSize");
  const stepSize = decimalField(lot, "stepSize");
  const minQuantity = decimalField(lot, "minQty");
  const maxQuantity = decimalField(lot, "maxQty");
  const minNotional = decimalField(notional, "minNotional");
  if (
    tickSize === null ||
    stepSize === null ||
    minQuantity === null ||
    maxQuantity === null ||
    minNotional === null
  ) {
    return refuse(
      "PROVIDER_UNAVAILABLE",
      `Binance's trading rules for ${symbol} are missing a field Kertel needs to size an order safely.`,
    );
  }

  const avgMinutes = notional?.["avgPriceMins"];
  return ok({
    symbol,
    baseAsset: String(record["baseAsset"] ?? ""),
    quoteAsset: String(record["quoteAsset"] ?? ""),
    tickSize,
    stepSize,
    minQuantity,
    maxQuantity,
    minNotional,
    marketMaxQuantity: decimalField(marketLot, "maxQty"),
    notionalAveragePriceMinutes: typeof avgMinutes === "number" ? avgMinutes : 5,
  });
}

/** Turn an account payload into balances, dropping anything unreadable. */
export function parseAccount(body: unknown): AccountSnapshot {
  const record = body as Record<string, unknown>;
  const balances = Array.isArray(record["balances"]) ? record["balances"] : [];
  return {
    accountRef: String(record["uid"] ?? "binance-spot"),
    canTradeSpot: record["canTrade"] === true,
    observedAt: instant(Date.now()),
    balances: balances.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const row = entry as Record<string, unknown>;
      const free = row["free"];
      const locked = row["locked"];
      if (typeof row["asset"] !== "string" || typeof free !== "string") return [];
      return [
        {
          asset: row["asset"],
          free: fp.parse(free),
          locked: typeof locked === "string" ? fp.parse(locked) : fp.parse("0"),
        },
      ];
    }),
  };
}

export function createBinanceClient(config: BinanceConfig): BinanceClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const apiKey = config.apiKey?.trim() ?? "";
  const apiSecret = config.apiSecret?.trim() ?? "";
  const credentialed = apiKey !== "" && apiSecret !== "";

  async function call(input: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly query: Record<string, string>;
    readonly signed: boolean;
    readonly timeoutMs: number;
    /** Set for requests whose failure must never be read as "did not happen". */
    readonly unknownOnTimeout?: boolean;
  }): Promise<Result<unknown, Refusal>> {
    const params = new URLSearchParams(input.query);

    if (input.signed) {
      if (!credentialed) {
        return refuse(
          "EXECUTION_ADAPTER_UNAVAILABLE",
          "No Binance API key is configured, so Kertel can read prices but cannot see the account or place an order.",
        );
      }
      params.set("timestamp", String(Date.now()));
      params.set("recvWindow", String(RECV_WINDOW_MS));
      params.set("signature", createHmac("sha256", apiSecret).update(params.toString()).digest("hex"));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const url = `${baseUrl}${input.path}?${params.toString()}`;
      const response = await doFetch(url, {
        method: input.method,
        headers: input.signed ? { "X-MBX-APIKEY": apiKey } : {},
        signal: controller.signal,
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }

      if (!response.ok) {
        if (typeof body === "object" && body !== null) {
          const record = body as { code?: unknown; msg?: unknown };
          if (typeof record.code === "number") {
            return { ok: false, error: refusalForCode(record.code, String(record.msg ?? "")) };
          }
        }
        return refuse(
          input.unknownOnTimeout === true ? "EXECUTION_RESULT_UNKNOWN" : "PROVIDER_UNAVAILABLE",
          `Binance answered ${String(response.status)}.`,
          { status: response.status },
        );
      }

      return ok(body);
    } catch (cause) {
      if (input.unknownOnTimeout === true) {
        // The request may have reached the matching engine. Saying "it failed"
        // is a claim nobody can support, and acting on it places the order
        // twice.
        return refuse(
          "EXECUTION_RESULT_UNKNOWN",
          "Kertel sent the order and did not get an answer. It does not know whether the order was placed and will not retry until that is reconciled.",
          { reason: cause instanceof Error ? cause.name : "unknown" },
        );
      }
      return refuse("PROVIDER_UNAVAILABLE", "Binance could not be reached.", {
        reason: cause instanceof Error ? cause.name : "unknown",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    credentialed,

    async filters(symbol: Symbol_): Promise<Result<SymbolFilters, Refusal>> {
      const result = await call({
        path: "/api/v3/exchangeInfo",
        method: "GET",
        query: { symbol },
        signed: false,
        timeoutMs: MARKET_TIMEOUT_MS,
      });
      if (!result.ok) return result;

      const symbols = (result.value as { symbols?: unknown }).symbols;
      const entry = Array.isArray(symbols) ? symbols[0] : undefined;
      if (typeof entry !== "object" || entry === null) {
        return refuse("PROVIDER_UNAVAILABLE", `Binance published no trading rules for ${symbol}.`);
      }
      const record = entry as Record<string, unknown>;
      if (record["status"] !== "TRADING") {
        return refuse(
          "SYMBOL_NOT_ALLOWED",
          `${symbol} is not currently trading on Binance (status ${String(record["status"])}).`,
        );
      }

      const list = Array.isArray(record["filters"]) ? (record["filters"] as FilterEntry[]) : [];
      const price = filterOf(list, "PRICE_FILTER");
      const lot = filterOf(list, "LOT_SIZE");
      const marketLot = filterOf(list, "MARKET_LOT_SIZE");
      const notional = filterOf(list, "NOTIONAL");

      const tickSize = decimalField(price, "tickSize");
      const stepSize = decimalField(lot, "stepSize");
      const minQuantity = decimalField(lot, "minQty");
      const maxQuantity = decimalField(lot, "maxQty");
      const minNotional = decimalField(notional, "minNotional");
      if (
        tickSize === null ||
        stepSize === null ||
        minQuantity === null ||
        maxQuantity === null ||
        minNotional === null
      ) {
        return refuse(
          "PROVIDER_UNAVAILABLE",
          `Binance's trading rules for ${symbol} are missing a field Kertel needs to size an order safely.`,
        );
      }

      const avgMinutes = notional?.["avgPriceMins"];

      return ok({
        symbol,
        baseAsset: String(record["baseAsset"] ?? ""),
        quoteAsset: String(record["quoteAsset"] ?? ""),
        tickSize,
        stepSize,
        minQuantity,
        maxQuantity,
        minNotional,
        marketMaxQuantity: decimalField(marketLot, "maxQty"),
        notionalAveragePriceMinutes: typeof avgMinutes === "number" ? avgMinutes : 5,
      });
    },

    async market(symbol: Symbol_): Promise<Result<MarketSnapshot, Refusal>> {
      // Two free calls. `avgPrice` is the figure the exchange's own notional
      // filter is evaluated against, so sizing without it means clearing a
      // minimum against a number the exchange will not use.
      const [tickerResult, averageResult] = await Promise.all([
        call({
          path: "/api/v3/ticker/bookTicker",
          method: "GET",
          query: { symbol },
          signed: false,
          timeoutMs: MARKET_TIMEOUT_MS,
        }),
        call({
          path: "/api/v3/avgPrice",
          method: "GET",
          query: { symbol },
          signed: false,
          timeoutMs: MARKET_TIMEOUT_MS,
        }),
      ]);
      if (!tickerResult.ok) return tickerResult;

      const ticker = tickerResult.value as Record<string, unknown>;
      const bid = ticker["bidPrice"];
      const ask = ticker["askPrice"];
      if (typeof bid !== "string" || typeof ask !== "string") {
        return refuse("MARKET_DATA_STALE", `Binance returned no usable book for ${symbol}.`);
      }

      // A missing average is survivable and the proposal gate says so; a wrong
      // one is not, so it is only taken when it parses.
      let averagePrice: FixedPoint | null = null;
      if (averageResult.ok) {
        const raw = (averageResult.value as Record<string, unknown>)["price"];
        if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw)) {
          averagePrice = fp.parse(raw);
        }
      }

      const bestBid = fp.parse(bid);
      const bestAsk = fp.parse(ask);
      return ok({
        symbol,
        // A buy fills at the ask. Sizing from the midpoint or the last trade
        // under-states what the order costs.
        lastPrice: bestAsk,
        bestBid,
        bestAsk,
        averagePrice,
        observedAt: instant(Date.now()),
        source: "binance:bookTicker+avgPrice",
      });
    },

    async account(): Promise<Result<AccountSnapshot, Refusal>> {
      const result = await call({
        path: "/api/v3/account",
        method: "GET",
        query: { omitZeroBalances: "true" },
        signed: true,
        timeoutMs: MARKET_TIMEOUT_MS,
      });
      if (!result.ok) return result;

      const record = result.value as Record<string, unknown>;
      const balances = Array.isArray(record["balances"]) ? record["balances"] : [];
      return ok({
        accountRef: String(record["uid"] ?? "binance-spot"),
        canTradeSpot: record["canTrade"] === true,
        observedAt: instant(Date.now()),
        balances: balances.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const row = entry as Record<string, unknown>;
          const free = row["free"];
          const locked = row["locked"];
          if (typeof row["asset"] !== "string" || typeof free !== "string") return [];
          return [
            {
              asset: row["asset"],
              free: fp.parse(free),
              locked: typeof locked === "string" ? fp.parse(locked) : fp.parse("0"),
            },
          ];
        }),
      });
    },

    async placeMarketOrder(input): Promise<Result<PlacedOrder, Refusal>> {
      const result = await call({
        path: "/api/v3/order",
        method: "POST",
        query: {
          symbol: input.symbol,
          side: input.side,
          type: "MARKET",
          quantity: fp.format(input.quantity),
          newClientOrderId: input.clientOrderId,
          newOrderRespType: "FULL",
        },
        signed: true,
        timeoutMs: ORDER_TIMEOUT_MS,
        unknownOnTimeout: true,
      });
      if (!result.ok) return result;
      return ok(parseOrder(result.value as OrderResponse));
    },

    async findOrder(symbol, clientOrderId): Promise<Result<PlacedOrder | null, Refusal>> {
      const result = await call({
        path: "/api/v3/order",
        method: "GET",
        query: { symbol, origClientOrderId: clientOrderId },
        signed: true,
        timeoutMs: MARKET_TIMEOUT_MS,
      });
      if (!result.ok) {
        // "No such order" is the answer, not an error: it is how reconciliation
        // learns the order never reached the book.
        return result.error.code === "EXCHANGE_REJECTED" &&
          result.error.context?.["code"] === -2013
          ? ok(null)
          : result;
      }
      return ok(parseOrder(result.value as OrderResponse));
    },
  };
}
