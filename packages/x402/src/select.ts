/**
 * Reading a 402 challenge and choosing what, if anything, to pay.
 *
 * Pure functions, no network, so every branch below is tested against the real
 * challenges saved under `fixtures/x402/live-quotes/`. This is where the two
 * traps that would otherwise sink the integration are handled:
 *
 * 1. The challenge is in a base64 response header for CoinGecko and The Graph,
 *    and in the response body for CoinMarketCap and Nansen. Both are live.
 * 2. Providers offer up to eight payment options across four chains and five
 *    assets. Taking the first one, as the default selector does, would have
 *    Kertel signing a permit2 allowance on BSC.
 */

import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import type { Refusal, Result } from "@kertel/core/domain";
import { ok, refuse } from "@kertel/core/domain";

import {
  ACCEPTED_TRANSFER_METHOD,
  MERCHANT_PINS,
  PAYMENT_RAILS,
  PAYMENT_REQUIRED_HEADER,
} from "./constants.js";
import type { MerchantPin, PaymentRail } from "./constants.js";
import type { X402Quote } from "./types.js";

export type ChallengeSource = "header" | "body";

export type ReadChallenge = {
  readonly challenge: PaymentRequired;
  readonly source: ChallengeSource;
};

function decodeBase64Json(encoded: string): unknown {
  const json = Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(json) as unknown;
}

function looksLikeChallenge(value: unknown): value is PaymentRequired {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { x402Version?: unknown; accepts?: unknown };
  return typeof candidate.x402Version === "number" && Array.isArray(candidate.accepts);
}

/**
 * Find the challenge wherever this particular provider put it.
 *
 * Header first. CoinGecko's body is `{"error":"Payment required"}` and The
 * Graph's is empty, so a body-only reader sees nothing to work with and would
 * report both as broken providers rather than as priced ones.
 */
export function readChallenge(input: {
  readonly status: number;
  readonly getHeader: (name: string) => string | null | undefined;
  readonly body: unknown;
}): Result<ReadChallenge, Refusal> {
  if (input.status !== 402) {
    return refuse(
      "X402_NO_ACCEPTABLE_OPTION",
      `Expected a 402 payment challenge, the provider answered ${String(input.status)}.`,
      { status: input.status },
    );
  }

  const header = input.getHeader(PAYMENT_REQUIRED_HEADER);
  if (typeof header === "string" && header.trim() !== "") {
    let decoded: unknown;
    try {
      decoded = decodeBase64Json(header.trim());
    } catch {
      return refuse(
        "X402_NO_ACCEPTABLE_OPTION",
        "The provider sent a payment-required header Kertel could not decode.",
      );
    }
    if (!looksLikeChallenge(decoded)) {
      return refuse(
        "X402_NO_ACCEPTABLE_OPTION",
        "The provider's payment-required header was not an x402 challenge.",
      );
    }
    return ok({ challenge: decoded, source: "header" });
  }

  if (looksLikeChallenge(input.body)) {
    return ok({ challenge: input.body, source: "body" });
  }

  return refuse(
    "X402_NO_ACCEPTABLE_OPTION",
    "The provider asked for payment but sent no challenge Kertel could read.",
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Does this option match one specific rail?
 *
 * Four conditions, all required. The transfer-method check is the one that is
 * easy to leave out: providers offer the same asset on the same chain under
 * both `eip3009` and `permit2-exact`, and only the first is an authorisation to
 * make a single payment.
 *
 * An option with no `assetTransferMethod` is EIP-3009 by default, which is how
 * CoinGecko, Nansen and The Graph present Base USDC. An option that names a
 * method must name this one.
 */
function matchesRail(option: PaymentRequirements, rail: PaymentRail): boolean {
  if (option.scheme !== "exact") return false;
  if (option.network !== rail.network) return false;
  if (!sameAddress(option.asset, rail.asset)) return false;

  const method = option.extra["assetTransferMethod"];
  if (method === undefined || method === null) return true;
  return method === ACCEPTED_TRANSFER_METHOD;
}

export type SelectedOption = {
  readonly option: PaymentRequirements;
  /** Which rail was chosen, and therefore who settles it. */
  readonly rail: PaymentRail;
  readonly amount: FixedPoint;
  readonly offeredOptions: number;
  readonly acceptableOptions: number;
};

/**
 * Choose the rail to pay over, and refuse rather than settle for a near miss.
 *
 * Rails are tried in preference order, so where a provider takes Binance's own
 * B402 rail Kertel uses it, and falls back to Base USDC only where it must. The
 * amount is read at the chosen rail's decimals: the BSC stablecoins carry 18
 * and Base USDC carries 6, and reading one at the other's scale is the
 * difference between a cent and ten thousand dollars.
 *
 * The recipient check happens here, before signing, because after signing is
 * too late: an EIP-3009 authorisation naming the wrong `to` is a signed
 * instruction to pay a stranger. A mismatch stops the whole selection rather
 * than falling through to another rail, since a wrong address on one option
 * means this challenge is not trustworthy at all.
 */
/** Money is shown to a person in cents, so never trim below two decimals. */
const MONEY_SCALE = 2;

export function selectPaymentOption(input: {
  readonly challenge: PaymentRequired;
  readonly pin: MerchantPin;
  /** Defaults to the registry order: BSC U, then BSC USD1, then Base USDC. */
  readonly railPreference?: readonly PaymentRail[];
}): Result<SelectedOption, Refusal> {
  const offered = input.challenge.accepts;
  if (offered.length === 0) {
    return refuse("X402_NO_ACCEPTABLE_OPTION", "The provider offered no way to pay.");
  }

  const rails = input.railPreference ?? PAYMENT_RAILS;
  const acceptableOptions = offered.filter((option) =>
    rails.some((rail) => matchesRail(option, rail)),
  ).length;

  for (const rail of rails) {
    const chosen = offered.find((option) => matchesRail(option, rail));
    if (chosen === undefined) {
      continue;
    }

    if (!sameAddress(chosen.payTo, input.pin.payTo)) {
      return refuse(
        "X402_RECIPIENT_MISMATCH",
        "The provider asked Kertel to pay an address it does not recognise, so nothing was signed.",
        { expected: input.pin.payTo, offered: chosen.payTo, host: input.pin.host, rail: rail.id },
      );
    }

    let amount: FixedPoint;
    try {
      // The rail's decimals are how the chain encodes the figure, not how much
      // the call costs. Trimming here keeps one cent reading as `0.01` whether
      // it arrived as six decimals on Base or eighteen on BNB Smart Chain, and
      // stops a mixed-rail run inheriting eighteen decimals in its total.
      amount = fp.trim(fp.fromAtoms(BigInt(chosen.amount), rail.decimals), MONEY_SCALE);
    } catch {
      return refuse(
        "X402_NO_ACCEPTABLE_OPTION",
        "The provider quoted an amount Kertel could not read as an exact integer.",
        { amount: String(chosen.amount), rail: rail.id },
      );
    }
    if (fp.isNegative(amount)) {
      return refuse("X402_NO_ACCEPTABLE_OPTION", "The provider quoted a negative amount.");
    }

    return ok({ option: chosen, rail, amount, offeredOptions: offered.length, acceptableOptions });
  }

  return refuse(
    "X402_ASSET_NOT_PINNED",
    "This provider offers no rail Kertel will sign for: it needs U or USD1 on BNB Smart Chain, or USDC on Base, each with a single-payment authorisation.",
    {
      offered: offered.length,
      networks: [...new Set(offered.map((option) => option.network))].join(", "),
    },
  );
}

export function pinFor(providerId: string): Result<MerchantPin, Refusal> {
  const pin = MERCHANT_PINS[providerId];
  if (pin === undefined) {
    return refuse(
      "X402_RECIPIENT_MISMATCH",
      `Kertel has no pinned recipient for ${providerId}, so it will not pay it.`,
      { providerId },
    );
  }
  return ok(pin);
}

/** Check the URL belongs to the provider it claims to, before anything is sent. */
export function assertHostMatchesPin(url: string, pin: MerchantPin): Result<URL, Refusal> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse("X402_RECIPIENT_MISMATCH", "That is not a URL Kertel can call.", { url });
  }
  if (parsed.protocol !== "https:") {
    return refuse("X402_RECIPIENT_MISMATCH", "Kertel only calls paid endpoints over https.", {
      protocol: parsed.protocol,
    });
  }
  if (parsed.hostname.toLowerCase() !== pin.host.toLowerCase()) {
    return refuse(
      "X402_RECIPIENT_MISMATCH",
      "That URL does not belong to the provider it was built for.",
      { expected: pin.host, actual: parsed.hostname },
    );
  }
  return ok(parsed);
}

export function buildQuote(input: {
  readonly providerId: string;
  readonly endpointId: string;
  readonly url: string;
  readonly selected: SelectedOption;
  readonly source: ChallengeSource;
}): X402Quote {
  return {
    providerId: input.providerId,
    endpointId: input.endpointId,
    url: input.url,
    rail: input.selected.rail.id,
    assetName: input.selected.rail.assetName,
    facilitator: input.selected.rail.facilitator,
    network: input.selected.option.network,
    asset: input.selected.option.asset,
    amount: input.selected.amount,
    payTo: input.selected.option.payTo,
    maxTimeoutSeconds: input.selected.option.maxTimeoutSeconds,
    challengeSource: input.source,
    offeredOptions: input.selected.offeredOptions,
    acceptableOptions: input.selected.acceptableOptions,
  };
}
