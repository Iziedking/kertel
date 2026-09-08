/**
 * Trading through Binance Agent OS.
 *
 * This is Telt's preferred execution path. Orders placed here land in the
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
 *    `tool_execute({ toolName, arguments })` works. Telt uses the wrapper for
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

import * as fp from "@telt/core/money";
import { instant, ok, refuse } from "@telt/core/domain";
import type {
  AccountSnapshot,
  MarketSnapshot,
  Refusal,
  Result,
  SymbolFilters,
  Symbol_,
} from "@telt/core/domain";

import { parseAccount, parseExchangeInfo, parseOrder, refusalForCode, toMover } from "./binance.js";
import type { BinanceClient, OrderResponse, PlacedOrder } from "./binance.js";
import type { Mover } from "@telt/core/research";
import type { ToolCaller } from "./futures.js";

const DEFAULT_URL = "https://agent.binance.com/mcp/agentic";

export type AgentOsConfig = {
  readonly token: string;
  readonly url?: string;
  /** Unused: every read goes through the authenticated session. Kept for symmetry with the REST client. */
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

export type AgentOsHandle = {
  readonly spot: BinanceClient;
  /** The same authenticated session, for callers that speak other Binance products. */
  readonly call: ToolCaller;
};

export function createAgentOsClient(config: AgentOsConfig): BinanceClient {
  return createAgentOs(config).spot;
}

export function createAgentOs(config: AgentOsConfig): AgentOsHandle {
  const url = config.url ?? DEFAULT_URL;

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
      const next = new Client({ name: "telt", version: "0.1.0" }, { capabilities: {} });
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
        `Telt could not reach Binance Agent OS. The token may have expired; it lasts thirty days and is renewed by signing in again. (${cause instanceof Error ? cause.message : "unknown"})`,
      );
    }

    let result: ToolResult;
    try {
      result = (await connected.callTool({
        name: "tool_execute",
        arguments: { toolName, arguments: args },
      })) as ToolResult;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      // Binance's own error survives inside the MCP error text. An invalid
      // symbol is the exchange answering, not the transport failing, and
      // reporting it as unreachable sends the reader to check their network.
      const embedded = /"code"\s*:\s*(-?\d+)/.exec(message);
      if (embedded !== null && options.unknownOnFailure !== true) {
        const code = Number(embedded[1]);
        const detail = /"msg"\s*:\s*"([^"]*)"/.exec(message)?.[1] ?? message.slice(0, 160);
        if (code === -1121 || /invalid symbol/i.test(detail)) {
          return refuse(
            "SYMBOL_NOT_ALLOWED",
            `Binance does not list that symbol. Check the exact pair, for example ETHUSDT rather than ETH.`,
            { code },
          );
        }
        return { ok: false, error: refusalForCode(code, detail) };
      }

      // The session may have died. Drop it so the next call redials.
      client = null;
      if (options.unknownOnFailure === true) {
        return refuse(
          "EXECUTION_RESULT_UNKNOWN",
          "Telt sent the order to Agent OS and did not get an answer. It does not know whether the order was placed and will not retry until that is reconciled.",
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
        `Agent OS answered ${toolName} in a shape Telt does not recognise.`,
      );
    }
  }

  const spot: BinanceClient = {
    credentialed: true,

    async filters(symbol: Symbol_): Promise<Result<SymbolFilters, Refusal>> {
      const result = await call("spot.exchangeInfo", { symbol });
      if (!result.ok) return result;
      return parseExchangeInfo(result.value, symbol);
    },

    async movers(): Promise<Result<readonly Mover[], Refusal>> {
      // Omitting the symbol asks for every pair at once.
      const result = await call("spot.ticker24hr", {});
      if (!result.ok) return result;
      if (!Array.isArray(result.value)) {
        return refuse("MARKET_DATA_STALE", "Agent OS returned no usable 24-hour ticker.");
      }
      const movers = result.value.map(toMover).filter((row): row is Mover => row !== null);
      if (movers.length === 0) {
        return refuse("MARKET_DATA_STALE", "The 24-hour ticker had no readable rows.");
      }
      return ok(movers);
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
      const average = await call("spot.avgPrice", { symbol });
      if (average.ok) {
        const raw = (average.value as Record<string, unknown>)["price"];
        if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw)) {
          averagePrice = fp.parse(raw);
        }
      }
      // A missing average is survivable: the proposal gate falls back to the
      // last price and says which it used.

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
        // Telt learns an order never reached the book.
        return result.error.code === "EXCHANGE_REJECTED" &&
          result.error.context?.["code"] === -2013
          ? ok(null)
          : result;
      }
      return ok(parseOrder(result.value as OrderResponse));
    },
  };

  return { spot, call };
}
