/**
 * How each paid provider names an asset Binance calls `ETHUSDT`.
 *
 * CoinGecko says `ethereum`, CoinMarketCap says `1027`, Nansen answers in token
 * contracts on a named chain. Deriving those from a ticker — lowercasing it,
 * stripping `USDT`, guessing a contract — is how a request ends up pointed at
 * the wrong asset, and every one of those calls costs money and then gets
 * priced into an order. So the mapping is written down and checked by hand.
 *
 * **This table does not decide what Kertel can trade.** Binance's own
 * `exchangeInfo` decides that, and it is authoritative: asking the exchange
 * whether a symbol is real involves no guesswork at all. A symbol missing from
 * this table is still tradeable; it simply cannot be corroborated by a paid
 * source, so research falls back to what Binance itself publishes and the
 * receipt says which sources were unavailable and why.
 *
 * That split matters. Confusing "Kertel has no CoinGecko id for this" with
 * "Kertel cannot trade this" is what limited it to two symbols.
 */

import type { Symbol_ } from "@kertel/core/domain";

export type InstrumentIds = {
  readonly symbol: Symbol_;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** CoinGecko coin id, from its `/coins/list`. Null when unmapped. */
  readonly coingeckoId: string | null;
  /**
   * CoinMarketCap's numeric id, used as the `id` query parameter.
   *
   * Preferred over the ticker because a ticker is ambiguous — several listed
   * assets share `ETH` — and CoinMarketCap's own x402 reference queries by id.
   * The answer comes back keyed by this id, so there is nothing to disambiguate
   * on the way back either.
   */
  readonly coinmarketcapId: number | null;
  /** CoinMarketCap ticker. Cross-checked against the payload, never the key. */
  readonly coinmarketcapSymbol: string | null;
  /** The chain Nansen tracks this asset's flows on. */
  readonly nansenChain: string | null;
  /**
   * Contracts that count as this asset in a Nansen netflow row, lowercased.
   *
   * Netflow is reported per token contract, and the wrapped form is what
   * appears for ETH and BTC. Matching on the contract rather than the ticker
   * keeps a same-named token on the same chain from being read as this one.
   */
  readonly nansenTokenAddresses: readonly string[];
  /** Tickers accepted as a fallback when a row carries no usable contract. */
  readonly nansenTokenSymbols: readonly string[];
};

/**
 * Two instruments, matching `defaultPolicy().allowedSymbols`.
 *
 * Deliberately short. Every entry here is an asset whose ids somebody verified
 * against each provider, and a table that grows by guesswork is worse than a
 * table that stays small.
 */
export const INSTRUMENTS: readonly InstrumentIds[] = Object.freeze([
  {
    symbol: "ETHUSDT" as Symbol_,
    baseAsset: "ETH",
    quoteAsset: "USDT",
    coingeckoId: "ethereum",
    coinmarketcapId: 1027,
    coinmarketcapSymbol: "ETH",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
    nansenTokenSymbols: ["ETH", "WETH"],
  },
  {
    symbol: "BTCUSDT" as Symbol_,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    coingeckoId: "bitcoin",
    coinmarketcapId: 1,
    coinmarketcapSymbol: "BTC",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"],
    nansenTokenSymbols: ["BTC", "WBTC"],
  },
]);

export function instrumentFor(symbol: Symbol_): InstrumentIds | undefined {
  return INSTRUMENTS.find((entry) => entry.symbol === symbol);
}

/** Whether any paid provider can be asked about this symbol. */
export function hasPaidCoverage(symbol: Symbol_): boolean {
  return instrumentFor(symbol) !== undefined;
}

/**
 * An instrument for a symbol nobody mapped.
 *
 * Built from what Binance itself reports, so the free venue tier works for any
 * listed pair. Every paid provider id is null, and each of those adapters
 * refuses by name rather than guessing an id — which is what turns "unmapped"
 * into a line on the receipt instead of a failure.
 */
export function unmappedInstrument(input: {
  readonly symbol: Symbol_;
  readonly baseAsset: string;
  readonly quoteAsset: string;
}): InstrumentIds {
  return {
    symbol: input.symbol,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    coingeckoId: null,
    coinmarketcapId: null,
    coinmarketcapSymbol: null,
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  };
}
