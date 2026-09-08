/**
 * What Telt is willing to pay with, and who it is willing to pay.
 *
 * Every value here was read from a live 402 challenge on 2026-09-07 and saved
 * verbatim under `fixtures/x402/live-quotes/`. Nothing came from a
 * documentation page: CoinMarketCap's own docs describe Base and USDC while its
 * live challenge also offers four BSC assets, and the BNB Chain studio
 * reference describes CMC as BSC-only, which the same challenge contradicts.
 * The challenge is the only thing that decides.
 *
 * Re-run `npm run probe:providers` to refresh these. If a `payTo` has moved,
 * that is a hard stop and a human decision, never an automatic update.
 */

/** CAIP-2 identifiers for the chains Telt can pay on. */
export const BSC_NETWORK = "eip155:56";
export const BASE_NETWORK = "eip155:8453";

/**
 * The only transfer method Telt signs.
 *
 * `eip3009` is a signed authorisation to move exactly the quoted amount,
 * exactly once, and it costs the payer no gas because the facilitator submits
 * it. `permit2-exact` first requires granting a standing allowance to a spender
 * contract, which is a much larger authority than one payment, so it is
 * refused. Most providers offer the same asset under both. Telt always takes
 * the narrower one, and where only permit2 is on offer it declines the asset.
 */
export const ACCEPTED_TRANSFER_METHOD = "eip3009";

export type RailId = "bsc-u" | "bsc-usd1" | "base-usdc";

export type PaymentRail = {
  readonly id: RailId;
  readonly network: string;
  readonly asset: string;
  /** As the challenge names it, so a receipt can say what was actually spent. */
  readonly assetName: string;
  /**
   * Token decimals. These differ per asset and getting one wrong is the
   * difference between paying a cent and paying ten thousand dollars: USDC on
   * Base has 6, the BSC stablecoins have 18. The amount in a challenge is
   * always atomic units of the asset it names.
   */
  readonly decimals: number;
  /** Who settles it on chain. Recorded in every receipt. */
  readonly facilitator: string;
  readonly note: string;
};

/**
 * The rails, in preference order.
 *
 * BSC first, deliberately. `U` and `USD1` on BNB Smart Chain settle through
 * B402, Binance's own x402 facilitator, which is the rail this product is being
 * built for. Where a provider offers it, Telt pays over Binance's
 * infrastructure rather than someone else's.
 *
 * Base USDC is the fallback and is not a lesser option: CoinGecko and The Graph
 * offer nothing else, so without it two of the four sources would be
 * unreachable. Both rails use the same EIP-3009 authorisation and the same
 * private key, and an EVM account has the same address on both chains, so this
 * is one wallet holding two balances rather than two wallets.
 *
 * Only `U` and `USD1` support EIP-3009 on BSC. BSC USDC and USDT are
 * permit2-only there and so are not rails Telt can use, whatever their
 * price.
 */
export const PAYMENT_RAILS: readonly PaymentRail[] = Object.freeze([
  {
    id: "bsc-u",
    network: BSC_NETWORK,
    asset: "0xcE24439F2D9C6a2289F741120FE202248B666666",
    assetName: "United Stables",
    decimals: 18,
    facilitator: "Binance B402",
    note: "Binance's own x402 rail. Gas is sponsored by the facilitator, so the payer needs no BNB.",
  },
  {
    id: "bsc-usd1",
    network: BSC_NETWORK,
    asset: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
    assetName: "World Liberty Financial USD",
    decimals: 18,
    facilitator: "Binance B402",
    note: "The second EIP-3009 asset on BSC. Used only when a provider takes it and not U.",
  },
  {
    id: "base-usdc",
    network: BASE_NETWORK,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetName: "USD Coin",
    decimals: 6,
    facilitator: "Base x402",
    note: "The fallback, and the only rail CoinGecko and The Graph offer.",
  },
]);

export function railById(id: RailId): PaymentRail | undefined {
  return PAYMENT_RAILS.find((rail) => rail.id === id);
}

/** Kept for the legacy import path and for tests that name Base explicitly. */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export type MerchantPin = {
  readonly host: string;
  /** Byte-compared, case-insensitively, against the live challenge on every payment. */
  readonly payTo: string;
  /** Rails this merchant was observed to offer. For drift detection, not for policy. */
  readonly observedRails: readonly RailId[];
  /** What a call cost when last probed. For drift detection, not for policy. */
  readonly observedPriceUsdc: string;
  readonly observedOn: string;
};

/**
 * Pinned recipients.
 *
 * This is the control that makes a tampered or hijacked 402 useless: a
 * challenge asking Telt to pay a different address is refused, whatever else
 * it says. Each merchant uses one address across every chain it offers, so a
 * single pin covers both rails.
 *
 * A merchant that legitimately rotates its address requires an edit here and a
 * human who checked the new one out of band.
 */
export const MERCHANT_PINS: Readonly<Record<string, MerchantPin>> = Object.freeze({
  coingecko: {
    host: "pro-api.coingecko.com",
    payTo: "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784",
    observedRails: ["base-usdc"],
    observedPriceUsdc: "0.01",
    observedOn: "2026-09-07",
  },
  coinmarketcap: {
    host: "pro-api.coinmarketcap.com",
    payTo: "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA",
    observedRails: ["bsc-u", "bsc-usd1", "base-usdc"],
    observedPriceUsdc: "0.01",
    observedOn: "2026-09-07",
  },
  nansen: {
    host: "api.nansen.ai",
    payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
    observedRails: ["bsc-u", "bsc-usd1", "base-usdc"],
    observedPriceUsdc: "0.05",
    observedOn: "2026-09-07",
  },
  openpulse: {
    host: "safety.openpulsechain.com",
    // Confirmed twice on 2026-09-08, and the two must agree before it is
    // pinned: the published catalogue at /.well-known/x402 names this address,
    // and the live 402 challenge on /api/v1/sentiment/ETH carries the same one.
    // A catalogue alone is a claim; a challenge alone could be tampered with in
    // flight. Two independent sources saying the same thing is the bar.
    payTo: "0x471DD912cdCDD6DB71a97E5a69531bD50229111d",
    observedRails: ["base-usdc"],
    // The cheapest of the three steps Telt buys here. Safety and sentiment are
    // a cent each; the live challenge decides what is actually approved.
    observedPriceUsdc: "0.005",
    observedOn: "2026-09-08",
  },
  thegraph: {
    host: "gateway.thegraph.com",
    payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
    observedRails: ["base-usdc"],
    observedPriceUsdc: "0.01",
    observedOn: "2026-09-07",
  },
});

/**
 * The header CoinGecko and The Graph delivered the challenge in on the first
 * probe, and that all four used on the second.
 *
 * Where the challenge lands is not a per-provider constant: it varies by
 * provider, by request headers, and over time. The reader tries the header
 * first and falls back to the body, and both paths have tests.
 */
export const PAYMENT_REQUIRED_HEADER = "payment-required";

/** Response header carrying the settlement result after a paid retry. */
export const PAYMENT_RESPONSE_HEADER = "payment-response";
