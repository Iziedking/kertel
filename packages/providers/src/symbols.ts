/**
 * How each paid provider names an asset Binance calls `ETHUSDT`.
 *
 * CoinGecko says `ethereum`, CoinMarketCap says `1027`, Nansen answers in token
 * contracts on a named chain. Deriving those from a ticker — lowercasing it,
 * stripping `USDT`, guessing a contract — is how a request ends up pointed at
 * the wrong asset, and every one of those calls costs money and then gets
 * priced into an order. So the mapping is written down and checked by hand.
 *
 * **This table does not decide what Telt can trade.** Binance's own
 * `exchangeInfo` decides that, and it is authoritative: asking the exchange
 * whether a symbol is real involves no guesswork at all. A symbol missing from
 * this table is still tradeable; it simply cannot be corroborated by a paid
 * source, so research falls back to what Binance itself publishes and the
 * receipt says which sources were unavailable and why.
 *
 * That split matters. Confusing "Telt has no CoinGecko id for this" with
 * "Telt cannot trade this" is what limited it to two symbols.
 */

import type { Symbol_ } from "@telt/core/domain";

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
/**
 * How the ids below were established, because guessing one is the mistake this
 * entire module exists to prevent.
 *
 * ETH and BTC were pinned by hand from each provider's own documentation.
 *
 * The thirty-two added on 2026-09-08 were resolved mechanically and then
 * checked: CoinGecko's public `/coins/list` was filtered to entries whose
 * ticker matched AND whose name matched the asset's canonical name, and only
 * a *single* surviving match was accepted. WIF was rejected by that rule — it
 * has seven entries under the ticker and two under the name — and is therefore
 * absent rather than guessed at.
 *
 * Every accepted id was then queried for a live price, and all thirty-two
 * returned one. A ticker that resolves to exactly one id is a candidate; an id
 * that returns a price for that asset is a verified one.
 *
 * Eight of them also carry a Nansen contract, which unlocks Smart Money flows —
 * the only evidence Telt buys that speaks to conviction rather than price. Those
 * eight are the ones where CoinGecko's published contract and Binance's own
 * Ethereum network address for the coin are byte-for-byte the same. Two
 * independent sources agreeing is the bar, because a flow attributed to the
 * wrong contract is a number that looks authoritative and describes a different
 * asset.
 *
 * RENDER and INJ are Ethereum ERC-20s and are deliberately absent from that
 * eight: only CoinGecko names their contract, and one source is a claim.
 *
 * The native L1 coins here — SOL, XRP, ADA, DOT, ATOM, NEAR, FIL and the rest —
 * have no Ethereum contract at all, so Nansen simply does not apply to them.
 * That is an answer rather than a gap, and the receipt says so by name.
 *
 * What Telt must never do is take the wrapped version. Binance lists a
 * BNB-Chain contract for SOL, XRP, ADA and others; those are Binance-pegged
 * wrappers, and flows through a wrapper describe the wrapper.
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
  {
    symbol: "SOLUSDT" as Symbol_,
    baseAsset: "SOL",
    quoteAsset: "USDT",
    coingeckoId: "solana",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "SOL",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "XRPUSDT" as Symbol_,
    baseAsset: "XRP",
    quoteAsset: "USDT",
    coingeckoId: "ripple",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "XRP",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "DOGEUSDT" as Symbol_,
    baseAsset: "DOGE",
    quoteAsset: "USDT",
    coingeckoId: "dogecoin",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "DOGE",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "ADAUSDT" as Symbol_,
    baseAsset: "ADA",
    quoteAsset: "USDT",
    coingeckoId: "cardano",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ADA",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "AVAXUSDT" as Symbol_,
    baseAsset: "AVAX",
    quoteAsset: "USDT",
    coingeckoId: "avalanche-2",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "AVAX",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "LINKUSDT" as Symbol_,
    baseAsset: "LINK",
    quoteAsset: "USDT",
    coingeckoId: "chainlink",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "LINK",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x514910771af9ca656af840dff83e8264ecf986ca"],
    nansenTokenSymbols: ["LINK"],
  },
  {
    symbol: "DOTUSDT" as Symbol_,
    baseAsset: "DOT",
    quoteAsset: "USDT",
    coingeckoId: "polkadot",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "DOT",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "TRXUSDT" as Symbol_,
    baseAsset: "TRX",
    quoteAsset: "USDT",
    coingeckoId: "tron",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "TRX",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "LTCUSDT" as Symbol_,
    baseAsset: "LTC",
    quoteAsset: "USDT",
    coingeckoId: "litecoin",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "LTC",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "BCHUSDT" as Symbol_,
    baseAsset: "BCH",
    quoteAsset: "USDT",
    coingeckoId: "bitcoin-cash",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "BCH",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "NEARUSDT" as Symbol_,
    baseAsset: "NEAR",
    quoteAsset: "USDT",
    coingeckoId: "near",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "NEAR",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "UNIUSDT" as Symbol_,
    baseAsset: "UNI",
    quoteAsset: "USDT",
    coingeckoId: "uniswap",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "UNI",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"],
    nansenTokenSymbols: ["UNI"],
  },
  {
    symbol: "ATOMUSDT" as Symbol_,
    baseAsset: "ATOM",
    quoteAsset: "USDT",
    coingeckoId: "cosmos",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ATOM",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "APTUSDT" as Symbol_,
    baseAsset: "APT",
    quoteAsset: "USDT",
    coingeckoId: "aptos",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "APT",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "ARBUSDT" as Symbol_,
    baseAsset: "ARB",
    quoteAsset: "USDT",
    coingeckoId: "arbitrum",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ARB",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0xb50721bcf8d664c30412cfbc6cf7a15145234ad1"],
    nansenTokenSymbols: ["ARB"],
  },
  {
    symbol: "OPUSDT" as Symbol_,
    baseAsset: "OP",
    quoteAsset: "USDT",
    coingeckoId: "optimism",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "OP",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "INJUSDT" as Symbol_,
    baseAsset: "INJ",
    quoteAsset: "USDT",
    coingeckoId: "injective-protocol",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "INJ",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "SUIUSDT" as Symbol_,
    baseAsset: "SUI",
    quoteAsset: "USDT",
    coingeckoId: "sui",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "SUI",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "SEIUSDT" as Symbol_,
    baseAsset: "SEI",
    quoteAsset: "USDT",
    coingeckoId: "sei-network",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "SEI",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "TIAUSDT" as Symbol_,
    baseAsset: "TIA",
    quoteAsset: "USDT",
    coingeckoId: "celestia",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "TIA",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "PEPEUSDT" as Symbol_,
    baseAsset: "PEPE",
    quoteAsset: "USDT",
    coingeckoId: "pepe",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "PEPE",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x6982508145454ce325ddbe47a25d4ec3d2311933"],
    nansenTokenSymbols: ["PEPE"],
  },
  {
    symbol: "SHIBUSDT" as Symbol_,
    baseAsset: "SHIB",
    quoteAsset: "USDT",
    coingeckoId: "shiba-inu",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "SHIB",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce"],
    nansenTokenSymbols: ["SHIB"],
  },
  {
    symbol: "BONKUSDT" as Symbol_,
    baseAsset: "BONK",
    quoteAsset: "USDT",
    coingeckoId: "bonk",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "BONK",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "RENDERUSDT" as Symbol_,
    baseAsset: "RENDER",
    quoteAsset: "USDT",
    coingeckoId: "render-token",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "RENDER",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "FILUSDT" as Symbol_,
    baseAsset: "FIL",
    quoteAsset: "USDT",
    coingeckoId: "filecoin",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "FIL",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "HBARUSDT" as Symbol_,
    baseAsset: "HBAR",
    quoteAsset: "USDT",
    coingeckoId: "hedera-hashgraph",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "HBAR",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "ICPUSDT" as Symbol_,
    baseAsset: "ICP",
    quoteAsset: "USDT",
    coingeckoId: "internet-computer",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ICP",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "AAVEUSDT" as Symbol_,
    baseAsset: "AAVE",
    quoteAsset: "USDT",
    coingeckoId: "aave",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "AAVE",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"],
    nansenTokenSymbols: ["AAVE"],
  },
  {
    symbol: "ETCUSDT" as Symbol_,
    baseAsset: "ETC",
    quoteAsset: "USDT",
    coingeckoId: "ethereum-classic",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ETC",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "STXUSDT" as Symbol_,
    baseAsset: "STX",
    quoteAsset: "USDT",
    coingeckoId: "blockstack",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "STX",
    nansenChain: null,
    nansenTokenAddresses: [],
    nansenTokenSymbols: [],
  },
  {
    symbol: "ENAUSDT" as Symbol_,
    baseAsset: "ENA",
    quoteAsset: "USDT",
    coingeckoId: "ethena",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ENA",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0x57e114b691db790c35207b2e685d4a43181e6061"],
    nansenTokenSymbols: ["ENA"],
  },
  {
    symbol: "ONDOUSDT" as Symbol_,
    baseAsset: "ONDO",
    quoteAsset: "USDT",
    coingeckoId: "ondo-finance",
    // No CoinMarketCap id and no Nansen contract were verified for these, so
    // both refuse by name on the receipt. Binance plus CoinGecko is still two
    // independent prices, which is what corroboration needs.
    coinmarketcapId: null,
    coinmarketcapSymbol: "ONDO",
    nansenChain: "ethereum",
    nansenTokenAddresses: ["0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3"],
    nansenTokenSymbols: ["ONDO"],
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
