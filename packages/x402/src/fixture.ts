/**
 * The fixture buyer. Fixture mode's whole footprint on the research path.
 *
 * Kertel has to run with no keys and no network — that is how the suite runs,
 * how the demo runs, and how anyone reviewing this repo can see it work without
 * being handed a funded wallet. The temptation in that situation is to write a
 * stub that returns a canned observation and skips the payment layer entirely,
 * and the result is a product whose tested path and whose real path have
 * nothing in common.
 *
 * So this client replaces exactly two things: the wire, and the signature. It
 * still runs the checks that matter, against the same functions the live client
 * calls:
 *
 *   - `pinFor` and `assertHostMatchesPin` — the merchant must be one Kertel
 *     knows, reached over https at the exact host that was pinned.
 *   - `readChallenge` — header first, then body, because both shapes are live.
 *   - `selectPaymentOption` — ranked rails, `eip3009` only, permit2 refused, the
 *     payTo byte-compared against the pin, and the amount read at the decimals
 *     of the chosen rail rather than a hard-coded six.
 *   - the approval re-check — a challenge that raised its price or moved its
 *     address between the quote and the payment is refused here too.
 *
 * What that buys: a fixture test that feeds in CoinMarketCap's real saved
 * challenge, with permit2 first in its `accepts` list and eighteen-decimal
 * amounts, and watches Kertel pick the right option — with no wallet anywhere
 * near it. A stub could not fail that test, which is precisely why it would not
 * be worth running.
 */

import * as fp from "@kertel/core/money";
import { ok, refuse } from "@kertel/core/domain";
import type { Refusal, Result } from "@kertel/core/domain";

import {
  assertHostMatchesPin,
  buildQuote,
  pinFor,
  readChallenge,
  selectPaymentOption,
} from "./select.js";
import type {
  ApprovedQuote,
  Hasher,
  PaidRequest,
  PaidResponse,
  QuoteOutcome,
  SettlementInfo,
  UnpaidResponse,
  X402Client,
} from "./types.js";

/**
 * One saved HTTP answer.
 *
 * `bodyText` is the raw text, not a parsed object, so a fixture can carry the
 * zero-length body The Graph really returns and the malformed JSON a provider
 * really might.
 */
export type FixtureResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyText: string;
};

/**
 * What one endpoint does across an unpaid probe and a paid retry.
 *
 * `paid` is optional. Leaving it out models a provider that takes the payment
 * and then does not answer, which is the case that must never be reported as a
 * clean failure.
 */
export type FixtureExchange = {
  readonly probe: FixtureResponse;
  readonly paid?: FixtureResponse;
};

export type FixtureClientConfig = {
  /** Keyed by `PaidRequest.endpointId`. */
  readonly exchanges: Readonly<Record<string, FixtureExchange>>;
  readonly hash: Hasher;
  /**
   * Whether fixture mode should behave as though a wallet exists.
   *
   * Defaults to true so the interesting paths are reachable. Set it false to
   * test what an operator sees before they have funded anything.
   */
  readonly walletConfigured?: boolean;
  /** Public, and fake. Shown in the health report exactly as the live one is. */
  readonly payerAddress?: string;
};

const FIXTURE_PAYER = "0x0000000000000000000000000000000000000f1x";

function headerReader(response: FixtureResponse): (name: string) => string | null {
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    lowered.set(key.toLowerCase(), value);
  }
  return (name) => lowered.get(name.toLowerCase()) ?? null;
}

function parseBody(bodyText: string): unknown {
  if (bodyText.trim() === "") {
    return "";
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

export function createFixtureX402Client(config: FixtureClientConfig): X402Client {
  const walletConfigured = config.walletConfigured ?? true;

  function exchangeFor(request: PaidRequest): Result<FixtureExchange, Refusal> {
    const exchange = config.exchanges[request.endpointId];
    if (exchange === undefined) {
      // A step with no fixture is a hole in the demo, not a provider outage.
      // Saying so plainly beats a fake timeout that sends someone debugging a
      // network that was never involved.
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `Fixture mode has no saved answer for ${request.endpointId}.`,
        { provider: request.providerId, endpoint: request.endpointId },
      );
    }
    return ok(exchange);
  }

  /**
   * The pinned, rail-checked reading of a saved challenge.
   *
   * Deliberately the same sequence, in the same order, as the live client's
   * `challengeFor`. If one of these checks is ever loosened, the fixture suite
   * has to be loosened with it, which is the point.
   */
  function resolve(
    request: PaidRequest,
    response: FixtureResponse,
  ): Result<
    | { readonly kind: "free"; readonly response: UnpaidResponse }
    | {
        readonly kind: "priced";
        readonly quote: ReturnType<typeof buildQuote>;
      },
    Refusal
  > {
    const pin = pinFor(request.providerId);
    if (!pin.ok) return pin;

    const host = assertHostMatchesPin(request.url, pin.value);
    if (!host.ok) return host;

    if (response.status !== 402) {
      if (response.status >= 200 && response.status < 300) {
        return ok({
          kind: "free",
          response: {
            status: response.status,
            body: parseBody(response.bodyText),
            bodyHash: config.hash(response.bodyText),
          },
        });
      }
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `${request.providerId} answered ${String(response.status)}.`,
        { provider: request.providerId, status: response.status },
      );
    }

    const read = readChallenge({
      status: response.status,
      getHeader: headerReader(response),
      body: parseBody(response.bodyText),
    });
    if (!read.ok) return read;

    const selected = selectPaymentOption({ challenge: read.value.challenge, pin: pin.value });
    if (!selected.ok) return selected;

    return ok({
      kind: "priced",
      quote: buildQuote({
        providerId: request.providerId,
        endpointId: request.endpointId,
        url: request.url,
        selected: selected.value,
        source: read.value.source,
      }),
    });
  }

  return {
    walletConfigured,
    payerAddress: walletConfigured ? (config.payerAddress ?? FIXTURE_PAYER) : null,

    async quote(request: PaidRequest): Promise<Result<QuoteOutcome, Refusal>> {
      const exchange = exchangeFor(request);
      if (!exchange.ok) return exchange;

      const resolved = resolve(request, exchange.value.probe);
      if (!resolved.ok) return resolved;

      return resolved.value.kind === "free"
        ? ok({ kind: "free", response: resolved.value.response })
        : ok({ kind: "payment_required", quote: resolved.value.quote });
    },

    async pay(
      request: PaidRequest,
      approved: ApprovedQuote,
    ): Promise<Result<PaidResponse, Refusal>> {
      if (!walletConfigured) {
        return refuse(
          "X402_WALLET_NOT_CONFIGURED",
          "No research wallet is configured, so Kertel cannot buy paid evidence.",
        );
      }

      const exchange = exchangeFor(request);
      if (!exchange.ok) return exchange;

      const resolved = resolve(request, exchange.value.probe);
      if (!resolved.ok) return resolved;

      if (resolved.value.kind === "free") {
        return refuse(
          "X402_NO_ACCEPTABLE_OPTION",
          `${request.providerId} stopped charging for this endpoint. Kertel did not pay; ask again to read it for free.`,
          { provider: request.providerId },
        );
      }

      const quote = resolved.value.quote;

      // Same re-check as the live client. A fixture that raises its price
      // between probe and retry is a cheap way to prove this holds.
      if (fp.greaterThan(quote.amount, approved.approvedAmount)) {
        return refuse(
          "X402_CALL_ABOVE_PER_CALL_CAP",
          `${request.providerId} now wants ${fp.format(quote.amount)} USDC, more than the ${fp.format(approved.approvedAmount)} that was approved.`,
          { quoted: fp.format(quote.amount), approved: fp.format(approved.approvedAmount) },
        );
      }
      if (quote.payTo.toLowerCase() !== approved.quote.payTo.toLowerCase()) {
        return refuse(
          "X402_RECIPIENT_MISMATCH",
          "The recipient changed between the quote and the payment, so Kertel signed nothing.",
          { approved: approved.quote.payTo, offered: quote.payTo },
        );
      }

      const answer = exchange.value.paid;
      if (answer === undefined) {
        // Signed, sent, nothing came back. The money may or may not have moved,
        // and that is exactly what the user is told.
        return refuse(
          "X402_PAYMENT_UNKNOWN",
          `Kertel signed a payment to ${request.providerId} and did not get an answer. It will not retry until that is resolved.`,
          { provider: request.providerId, amount: fp.format(quote.amount) },
        );
      }

      if (answer.status === 402) {
        return refuse("X402_PAYMENT_REJECTED", `${request.providerId} rejected the payment.`, {
          provider: request.providerId,
          status: answer.status,
        });
      }
      if (answer.status < 200 || answer.status >= 300) {
        return refuse(
          "X402_PAYMENT_UNKNOWN",
          `${request.providerId} answered ${String(answer.status)} after the payment was sent.`,
          { provider: request.providerId, status: answer.status },
        );
      }

      const settlement: SettlementInfo = {
        success: true,
        transaction: `0xfixture${request.endpointId.replace(/[^a-z0-9]/gi, "")}`,
        payer: config.payerAddress ?? FIXTURE_PAYER,
        network: quote.network,
      };

      return ok({
        quote,
        status: answer.status,
        body: parseBody(answer.bodyText),
        bodyHash: config.hash(answer.bodyText),
        amountPaid: quote.amount,
        settlement,
      });
    },
  };
}
