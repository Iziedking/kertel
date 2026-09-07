/**
 * Trading through Binance Agent OS.
 *
 * This is Kertel's preferred execution path. Orders placed here land in the
 * **Agentic sub-account**, which by Binance's own design can trade and move
 * funds internally and has no withdrawal scope at all. The granted scopes are
 * visible on the token and read, at the time of writing:
 *
 *   mcp:account:read  mcp:spot:trade  mcp:margin:loan
 *   mcp:futures:trade mcp:wallet:transfer mcp:master:read
 *
 * There is no withdrawal scope to grant. That is a stronger guarantee than an
 * API key with the withdrawal box unticked, because it is not a box anybody can
 * later tick.
 *
 * **Three things the live server does that its documentation does not say.**
 * All three were found by calling it, and each one breaks code written from the
 * docs:
 *
 * 1. **Tool names use dots, not underscores.** `spot.newOrder`, not
 *    `spot_newOrder`. The underscore form is what MCP clients rename them to.
 * 2. **`tools/list` is not the whole surface.** It returns fifty
 *    "always exposed" tools in alphabetical order, which stops partway through
 *    `margin.*` — every `spot.*` tool is past the cut and invisible there.
 * 3. **So everything goes through `tool_execute`.** Calling `spot.exchangeInfo`
 *    directly returns "Tool not found"; wrapping it in
 *    `tool_execute({ toolName, arguments })` works. Kertel uses the wrapper for
 *    every call, which also makes it immune to where that fifty-tool cut falls.
 *
 * **On the token.** The access token is a plain bearer credential and lasts
 * thirty days. Binance advertises `grant_types_supported: ["authorization_code"]`
 * with no refresh grant and no registration endpoint, so it cannot be renewed
 * silently — but thirty days is long enough that a server runs unattended
 * between browser logins rather than needing one per session.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import * as fp from "@kertel/core/money";
import { instant, ok, refuse } from "@kertel/core/domain";
import type {
  AccountSnapshot,
  MarketSnapshot,
  Refusal,
  Result,
  SymbolFilters,
  Symbol_,
} from "@kertel/core/domain";

import { parseAccount, parseExchangeInfo, parseOrder, refusalForCode } from "./binance.js";
import type { BinanceClient, OrderResponse, PlacedOrder } from "./binance.js";

const DEFAULT_URL = "https://agent.binance.com/mcp/agentic";
/** The venue's five-minute average, which Agent OS exposes no tool for. Free and unauthenticated. */
const AVG_PRICE_URL = "https://api.binance.com/api/v3/avgPrice";

export type AgentOsConfig = {
  readonly token: string;
  readonly url?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
};

type ToolResult = {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
};

/**
 * A Binance error arriving through MCP rather than HTTP.
 *
 * The exchange's own `{code, msg}` shape survives the trip, so the same mapping
 * that serves the REST client serves this one and a user sees one vocabulary of
 * refusals regardless of which rail carried the order.
 */
function refusalFromToolError(toolName: string, raw: string): Refusal {
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; msg?: unknown; message?: unknown };
    if (typeof parsed.code === "number") {
      return refusalForCode(parsed.code, String(parsed.msg ?? parsed.message ?? ""));
    }
    if (typeof parsed.message === "string") {
      return refuse("EXCHANGE_REJECTED", `Agent OS rejected ${toolName}: ${parsed.message}`).error;
    }
  } catch {
    // Not JSON. Fall through to the raw text, truncated.
  }
  return refuse("EXCHANGE_REJECTED", `Agent OS rejected ${toolName}: ${raw.slice(0, 200)}`).error;
}

export function createAgentOsClient(config: AgentOsConfig): BinanceClient {
  const url = config.url ?? DEFAULT_URL;
  const doFetch = config.fetchImpl ?? globalThis.fetch;

  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  async function connect(): Promise<Client> {
    if (client !== null) {
      return client;
    }
    // Share one in-flight connection: a sweep that reads filters, market and
    // account together must not open three sessions.
    connecting ??= (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      });
      const next = new Client({ name: "kertel", version: "0.1.0" }, { capabilities: {} });
      // The SDK declares `Transport.sessionId?: string` while this transport
      // exposes `string | undefined`, which `exactOptionalPropertyTypes` treats
      // as different types. The runtime shape is right; only the declaration
      // disagrees, so the cast is confined to this one line.
      await next.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      client = next;
      return next;
    })();

    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  /**
   * Run one Agent OS tool.
   *
   * `unknownOnFailure` is set for the order call alone. A request that may have
   * reached the matching engine and did not answer is not a failure, and saying
   * it is places the order twice on the retry.
   */
  async function call(
    toolName: string,
    args: Record<string, unknown>,
    options: { readonly unknownOnFailure?: boolean } = {},
  ): Promise<Result<unknown, Refusal>> {
    let connected: Client;
    try {
      connected = await connect();
    } catch (cause) {
      return refuse(
        "EXECUTION_ADAPTER_UNAVAILABLE",
        `Kertel could not reach Binance Agent OS. The token may have expired; it lasts thirty days and is renewed by signing in again. (${cause instanceof Error ? cause.message : "unknown"})`,
      );
    }

    let result: ToolResult;
    try {
      result = (await connected.callTool({
        name: "tool_execute",
        arguments: { toolName, arguments: args },
      })) as ToolResult;
    } catch (cause) {
      // The session may have died. Drop it so the next call redials.
      client = null;
      if (options.unknownOnFailure === true) {
        return refuse(
          "EXECUTION_RESULT_UNKNOWN",
          "Kertel sent the order to Agent OS and did not get an answer. It does not know whether the order was placed and will not retry until that is reconciled.",
          { reason: cause instanceof Error ? cause.message.slice(0, 120) : "unknown" },
        );
      }
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `Agent OS did not answer ${toolName}.`,
        { reason: cause instanceof Error ? cause.message.slice(0, 120) : "unknown" },
      );
    }

    const text = result.content?.[0]?.text ?? "";
    if (result.isError === true) {
      return { ok: false, error: refusalFromToolError(toolName, text) };
    }

    try {
      return ok(JSON.parse(text) as unknown);
    } catch {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `Agent OS answered ${toolName} in a shape Kertel does not recognise.`,
      );
    }
  }

  return {
    credentialed: true,

    async filters(symbol: Symbol_): Promise<Result<SymbolFilters, Refusal>> {
      const result = await call("spot.exchangeInfo", { symbol });
      if (!result.ok) return result;
      return parseExchangeInfo(result.value, symbol);
    },

    async market(symbol: Symbol_): Promise<Result<MarketSnapshot, Refusal>> {
      const result = await call("spot.ticker24hr", { symbol });
      if (!result.ok) return result;

      const ticker = result.value as Record<string, unknown>;
      const bid = ticker["bidPrice"];
      const ask = ticker["askPrice"];
      if (typeof bid !== "string" || typeof ask !== "string") {
        return refuse("MARKET_DATA_STALE", `Agent OS returned no usable book for ${symbol}.`);
      }

      // Agent OS exposes no avgPrice tool, and `weightedAvgPrice` on the 24h
      // ticker is a different figure from the five-minute average the NOTIONAL
      // filter is evaluated against. The public endpoint is free and needs no
      // auth, so the correct number is used rather than a near one.
      let averagePrice: ReturnType<typeof fp.parse> | null = null;
      try {
        const response = await doFetch(`${AVG_PRICE_URL}?symbol=${symbol}`, {
          headers: { accept: "application/json" },
        });
        if (response.ok) {
          const body = (await response.json()) as { price?: unknown };
          if (typeof body.price === "string" && /^\d+(\.\d+)?$/.test(body.price)) {
            averagePrice = fp.parse(body.price);
          }
        }
      } catch {
        // Survivable: the proposal gate falls back to the last price and says so.
      }

      const bestBid = fp.parse(bid);
      const bestAsk = fp.parse(ask);
      return ok({
        symbol,
        // A buy fills at the ask. Sizing from the last trade under-states cost.
        lastPrice: bestAsk,
        bestBid,
        bestAsk,
        averagePrice,
        observedAt: instant(Date.now()),
        source: "binance:agent-os",
      });
    },

    async account(): Promise<Result<AccountSnapshot, Refusal>> {
      const result = await call("spot.getAccount", { omitZeroBalances: true });
      if (!result.ok) return result;
      return ok(parseAccount(result.value));
    },

    async placeMarketOrder(input): Promise<Result<PlacedOrder, Refusal>> {
      const result = await call(
        "spot.newOrder",
        {
          symbol: input.symbol,
          side: input.side,
          type: "MARKET",
          quantity: fp.format(input.quantity),
          newClientOrderId: input.clientOrderId,
          newOrderRespType: "FULL",
        },
        { unknownOnFailure: true },
      );
      if (!result.ok) return result;
      return ok(parseOrder(result.value as OrderResponse));
    },

    async findOrder(symbol, clientOrderId): Promise<Result<PlacedOrder | null, Refusal>> {
      const result = await call("spot.getOrder", { symbol, origClientOrderId: clientOrderId });
      if (!result.ok) {
        // "No such order" is reconciliation's answer, not its failure: it is how
        // Kertel learns an order never reached the book.
        return result.error.code === "EXCHANGE_REJECTED" &&
          result.error.context?.["code"] === -2013
          ? ok(null)
          : result;
      }
      return ok(parseOrder(result.value as OrderResponse));
    },
  };
}
