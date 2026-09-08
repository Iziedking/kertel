/**
 * Nansen Smart Money netflow, tier 2. Five cents, and the last thing bought.
 *
 * This is the only evidence in the system that speaks to conviction rather than
 * price. Three sources agreeing on what ETH costs says nothing about whether
 * anyone with a track record is buying it, and that is the question a trade
 * thesis actually turns on.
 *
 * It is also five times the price of everything else, so the planner reaches it
 * only after the price is settled, only when the question was "should I trade"
 * rather than "what is it doing", and never to resolve a price disagreement —
 * flows cannot arbitrate a price, and paying five cents to find that out is the
 * kind of spend that makes a research agent expensive and useless at once.
 *
 * Request body and response fields below come from the `extensions.bazaar`
 * block in Nansen's own live 402 challenge, saved at
 * `fixtures/x402/live-quotes/nansen-netflow-402.raw`, which carries a full JSON
 * Schema for both directions.
 *
 * A limit worth stating rather than hiding. Netflow is a *ranking*: the answer
 * is a page of tokens ordered by 24 hour net flow, and there is no documented
 * way to ask about one token directly. Ordering descending and taking a hundred
 * rows therefore surfaces the largest inflows, and a token that is missing may
 * be one nobody touched or one being heavily sold. The normaliser says exactly
 * that instead of reporting an absence as calm.
 */

import { ok, refuse } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";
import type { InstrumentIds } from "./symbols.js";
import { decimalFromJson } from "./decimal.js";

const ENDPOINT = "https://api.nansen.ai/api/v1/smart-money/netflow";

/** Nansen is the slowest of the four. Give it room before calling it down. */
const TIMEOUT_MS = 30_000;

/** One page, large enough that a serious flow in a major asset would appear. */
const PAGE_SIZE = 100;

type NetflowRow = {
  readonly token_address?: unknown;
  readonly token_symbol?: unknown;
  readonly chain?: unknown;
  readonly net_flow_1h_usd?: unknown;
  readonly net_flow_24h_usd?: unknown;
  readonly net_flow_7d_usd?: unknown;
  readonly net_flow_30d_usd?: unknown;
  readonly trader_count?: unknown;
};

function matches(row: NetflowRow, instrument: InstrumentIds): boolean {
  if (typeof row.chain === "string" && row.chain.toLowerCase() !== instrument.nansenChain) {
    return false;
  }
  // Contract first: it identifies the asset, where a ticker merely names it and
  // any number of tokens on one chain can share a name.
  if (typeof row.token_address === "string") {
    if (instrument.nansenTokenAddresses.includes(row.token_address.toLowerCase())) {
      return true;
    }
    return false;
  }
  return (
    typeof row.token_symbol === "string" &&
    instrument.nansenTokenSymbols.includes(row.token_symbol.toUpperCase())
  );
}

export const nansenNetflowAdapter: ProviderAdapter = {
  provider: "nansen",
  stepId: "nansen.netflow",
  capability: "smart_money.netflow",
  endpointId: "nansen:smart-money/netflow",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const chain = context.instrument.nansenChain;
    if (chain === null || context.instrument.nansenTokenAddresses.length === 0) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `Telt has no verified chain and contract for ${context.instrument.symbol}, so it cannot tell this token's flows from another with the same ticker.`,
        { provider: "nansen", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "nansen",
      endpointId: "nansen:smart-money/netflow",
      url: ENDPOINT,
      method: "POST",
      timeoutMs: TIMEOUT_MS,
      body: {
        chains: [chain],
        filters: {
          // ETH is native on its own chain, so excluding native tokens would
          // exclude half of what Telt is allowed to research.
          include_native_tokens: true,
          // Stablecoin flows are a funding signal, not a conviction one, and
          // they crowd out the rows this call is being bought for.
          include_stablecoins: false,
        },
        order_by: [{ field: "net_flow_24h_usd", direction: "DESC" }],
        pagination: { page: 1, per_page: PAGE_SIZE },
      },
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const rows = (body as { readonly data?: unknown }).data;
    if (!Array.isArray(rows)) {
      return null;
    }

    const instrument = context.instrument;
    if (instrument.nansenChain === null) {
      return null;
    }
    const row = rows.find(
      (candidate): candidate is NetflowRow =>
        typeof candidate === "object" &&
        candidate !== null &&
        matches(candidate as NetflowRow, instrument),
    );

    if (row === undefined) {
      // A real, paid-for answer, and not a good one to round off. Absence from a
      // descending ranking is consistent with no interest *and* with heavy
      // selling, so the note says which question this leaves open.
      return Object.freeze({
        tokenFound: false,
        chain: instrument.nansenChain,
        rowsScanned: rows.length,
        orderedBy: "net_flow_24h_usd descending",
        note: `${instrument.baseAsset} was not among the ${String(rows.length)} largest 24h Smart Money inflows on ${instrument.nansenChain}. A large outflow would not appear in this ranking either, so this shows no notable buying rather than showing calm.`,
      });
    }

    const netFlow24h = decimalFromJson(row.net_flow_24h_usd);
    if (netFlow24h === null) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      tokenFound: true,
      chain: instrument.nansenChain,
      netFlow24hUsd: netFlow24h,
    };
    if (typeof row.token_symbol === "string") {
      normalized["tokenSymbol"] = row.token_symbol;
    }
    if (typeof row.token_address === "string") {
      normalized["tokenAddress"] = row.token_address;
    }
    const netFlow1h = decimalFromJson(row.net_flow_1h_usd);
    if (netFlow1h !== null) {
      normalized["netFlow1hUsd"] = netFlow1h;
    }
    const netFlow7d = decimalFromJson(row.net_flow_7d_usd);
    if (netFlow7d !== null) {
      normalized["netFlow7dUsd"] = netFlow7d;
    }
    if (typeof row.trader_count === "number" && Number.isInteger(row.trader_count)) {
      normalized["traderCount"] = row.trader_count;
    }

    return Object.freeze(normalized);
  },
};
