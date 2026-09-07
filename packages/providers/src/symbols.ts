/**
 * The closed table of instruments Kertel knows how to research.
 *
 * Each provider names the same asset differently: Binance says `ETHUSDT`,
 * CoinGecko says `ethereum`, CoinMarketCap says `ETH`, Nansen answers in token
 * contracts on a named chain. Deriving those from each other — lowercasing a
 * symbol, stripping `USDT`, guessing a contract — is how a request ends up
 * pointed at the wrong asset, and every one of those calls costs money and then
 * gets priced into an order.
 *
 * So there is no derivation. An instrument Kertel can research is one somebody
 * wrote down here, with the ids checked by hand. A symbol that is not in this
 * table cannot be researched at all, which is the same answer the policy engine
 * gives for a symbol outside `allowedSymbols`, arrived at independently.
 */

import type { Symbol_ } from "@kertel/core/domain";

export type InstrumentIds = {
  readonly symbol: Symbol_;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** CoinGecko coin id, from its `/coins/list`. Not the ticker. */
  readonly coingeckoId: string;
  /**
   * CoinMarketCap's numeric id, used as the `id` query parameter.
   *
   * Preferred over the ticker because a ticker is ambiguous — several listed
   * assets share `ETH` — and CoinMarketCap's own x402 reference queries by id.
   * The answer comes back keyed by this id, so there is nothing to disambiguate
   * on the way back either.
   */
  readonly coinmarketcapId: number;
  /** CoinMarketCap ticker. Cross-checked against the payload, never the key. */
  readonly coinmarketcapSymbol: string;
  /** The chain Nansen tracks this asset's flows on. */
  readonly nansenChain: string;
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

export function isResearchable(symbol: Symbol_): boolean {
  return instrumentFor(symbol) !== undefined;
}
