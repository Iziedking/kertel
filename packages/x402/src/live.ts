/**
 * The live x402 buyer.
 *
 * Built against @x402/core 2.25.0 and @x402/evm 2.25.0, whose type declarations
 * were read at `node_modules/@x402/core/dist/cjs/x402Client-pTJv8yPe.d.ts` and
 * `node_modules/@x402/evm/dist/cjs/exact/client/index.d.ts` on 2026-09-07.
 *
 * The unscoped `x402` package on npm is version 1 of the protocol and cannot
 * talk to any provider Kertel uses: it pins `x402Versions = [1]`, expects
 * `maxAmountRequired` where these providers send `amount`, expects a `"base"`
 * name where they send `eip155:8453`, and reads the challenge from the body
 * only. See docs/feedback.md.
 *
 * What this module does, and does not do:
 *
 * - It signs. It is the only module in Kertel that can.
 * - It does not decide whether to spend. The caller must have run the policy
 *   engine and hand over an `ApprovedQuote`, and the live challenge is checked
 *   against that approval again here before anything is signed.
 * - It never logs, returns, or embeds the private key. `payerAddress` is public.
 */

import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

import * as fp from "@kertel/core/money";
import type { Refusal, Result } from "@kertel/core/domain";
import { ok, refuse } from "@kertel/core/domain";

import { PAYMENT_RESPONSE_HEADER } from "./constants.js";
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
  X402Client,
  X402Quote,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;

export type LiveClientConfig = {
  /** 0x-prefixed hex. Absent means every paid call refuses instead of crashing at boot. */
  readonly privateKey?: string | undefined;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly hash: Hasher;
};

type RawResponse = {
  readonly status: number;
  readonly getHeader: (name: string) => string | null;
  readonly body: unknown;
  readonly rawText: string;
};

async function readBody(response: Response): Promise<{ body: unknown; rawText: string }> {
  const rawText = await response.text();
  if (rawText.trim() === "") {
    // The Graph answers a 402 with a zero-length body and the challenge in a
    // header. Empty is a real shape here, not a failure.
    return { body: "", rawText };
  }
  try {
    return { body: JSON.parse(rawText) as unknown, rawText };
  } catch {
    return { body: rawText, rawText };
  }
}

export function createLiveX402Client(config: LiveClientConfig): X402Client {
  const doFetch = config.fetchImpl ?? globalThis.fetch;

  let account: PrivateKeyAccount | null = null;
  if (config.privateKey !== undefined && config.privateKey.trim() !== "") {
    // A malformed key is a configuration error the operator must see at boot,
    // not a refusal at the moment a user asks for research.
    account = privateKeyToAccount(config.privateKey.trim() as `0x${string}`);
  }

  async function send(
    request: PaidRequest,
    extraHeaders: Record<string, string>,
  ): Promise<Result<RawResponse, Refusal>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await doFetch(request.url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
      const { body, rawText } = await readBody(response);
      return ok({
        status: response.status,
        getHeader: (name) => response.headers.get(name),
        body,
        rawText,
      });
    } catch (cause) {
      const aborted = controller.signal.aborted;
      return refuse(
        aborted ? "PROVIDER_UNAVAILABLE" : "PROVIDER_UNAVAILABLE",
        aborted
          ? `${request.providerId} did not answer in time.`
          : `${request.providerId} could not be reached.`,
        { provider: request.providerId, reason: cause instanceof Error ? cause.name : "unknown" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Resolve a request to a live challenge and the one option Kertel will pay.
   *
   * Shared by `quote` and `pay` so the two cannot drift: the option that gets
   * signed is chosen by exactly the code that quoted it.
   */
  async function challengeFor(
    request: PaidRequest,
  ): Promise<
    Result<
      | { readonly kind: "free"; readonly raw: RawResponse }
      | {
          readonly kind: "priced";
          readonly raw: RawResponse;
          readonly challenge: PaymentRequired;
          readonly option: PaymentRequirements;
          readonly quote: X402Quote;
        },
      Refusal
    >
  > {
    const pin = pinFor(request.providerId);
    if (!pin.ok) return pin;

    const host = assertHostMatchesPin(request.url, pin.value);
    if (!host.ok) return host;

    const sent = await send(request, {});
    if (!sent.ok) return sent;
    const raw = sent.value;

    if (raw.status !== 402) {
      if (raw.status >= 200 && raw.status < 300) {
        return ok({ kind: "free", raw });
      }
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `${request.providerId} answered ${String(raw.status)}.`,
        { provider: request.providerId, status: raw.status },
      );
    }

    const read = readChallenge({
      status: raw.status,
      getHeader: raw.getHeader,
      body: raw.body,
    });
    if (!read.ok) return read;

    const selected = selectPaymentOption({ challenge: read.value.challenge, pin: pin.value });
    if (!selected.ok) return selected;

    return ok({
      kind: "priced",
      raw,
      challenge: read.value.challenge,
      option: selected.value.option,
      quote: buildQuote({
        providerId: request.providerId,
        endpointId: request.endpointId,
        url: request.url,
        selected: selected.value,
        source: read.value.source,
      }),
    });
  }

  function parseSettlement(getHeader: (name: string) => string | null): SettlementInfo | null {
    const header = getHeader(PAYMENT_RESPONSE_HEADER) ?? getHeader(`x-${PAYMENT_RESPONSE_HEADER}`);
    if (header === null || header.trim() === "") {
      return null;
    }
    try {
      const decoded = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")) as {
        success?: unknown;
        transaction?: unknown;
        payer?: unknown;
        network?: unknown;
      };
      return {
        success: decoded.success === true,
        transaction: typeof decoded.transaction === "string" ? decoded.transaction : null,
        payer: typeof decoded.payer === "string" ? decoded.payer : null,
        network: typeof decoded.network === "string" ? decoded.network : null,
      };
    } catch {
      // The data arrived and the payment happened. Only the confirmation is
      // unreadable, and the receipt will say so rather than invent a hash.
      return null;
    }
  }

  return {
    walletConfigured: account !== null,
    payerAddress: account?.address ?? null,

    async quote(request: PaidRequest): Promise<Result<QuoteOutcome, Refusal>> {
      const resolved = await challengeFor(request);
      if (!resolved.ok) return resolved;

      if (resolved.value.kind === "free") {
        return ok({
          kind: "free",
          response: {
            status: resolved.value.raw.status,
            body: resolved.value.raw.body,
            bodyHash: config.hash(resolved.value.raw.rawText),
          },
        });
      }
      return ok({ kind: "payment_required", quote: resolved.value.quote });
    },

    async pay(
      request: PaidRequest,
      approved: ApprovedQuote,
    ): Promise<Result<PaidResponse, Refusal>> {
      if (account === null) {
        return refuse(
          "X402_WALLET_NOT_CONFIGURED",
          "No research wallet is configured, so Kertel cannot buy paid evidence.",
        );
      }

      const resolved = await challengeFor(request);
      if (!resolved.ok) return resolved;

      if (resolved.value.kind === "free") {
        return refuse(
          "X402_NO_ACCEPTABLE_OPTION",
          `${request.providerId} stopped charging for this endpoint. Kertel did not pay; ask again to read it for free.`,
          { provider: request.providerId },
        );
      }

      const { challenge, option, quote } = resolved.value;

      // The approval was granted against a quote taken moments ago. Re-check it
      // against the challenge that is actually in hand, because the provider
      // could have raised its price or moved its address in between.
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

      // A fresh client per request keeps the selector bound to this one option.
      // The library's default selector takes the first entry in `accepts`, which
      // for CoinMarketCap is a permit2 authorisation on BSC.
      const client = new x402Client(() => option);
      registerExactEvmScheme(client, { signer: account });
      const http = new x402HTTPClient(client);

      let paymentHeaders: Record<string, string>;
      try {
        const payload = await http.createPaymentPayload(challenge);
        paymentHeaders = http.encodePaymentSignatureHeader(payload);
      } catch (cause) {
        return refuse(
          "X402_PAYMENT_REJECTED",
          `Kertel could not sign a payment for ${request.providerId}.`,
          { provider: request.providerId, reason: cause instanceof Error ? cause.message : "unknown" },
        );
      }

      const retried = await send(request, paymentHeaders);
      if (!retried.ok) {
        // The authorisation was signed and sent, and no answer came back. The
        // money may or may not have moved. Say exactly that; never report it as
        // a clean failure.
        return refuse(
          "X402_PAYMENT_UNKNOWN",
          `Kertel signed a payment to ${request.providerId} and did not get an answer. It will not retry until that is resolved.`,
          { provider: request.providerId, amount: fp.format(quote.amount) },
        );
      }

      const answer = retried.value;
      if (answer.status === 402) {
        return refuse(
          "X402_PAYMENT_REJECTED",
          `${request.providerId} rejected the payment.`,
          { provider: request.providerId, status: answer.status },
        );
      }
      if (answer.status < 200 || answer.status >= 300) {
        return refuse(
          "X402_PAYMENT_UNKNOWN",
          `${request.providerId} answered ${String(answer.status)} after the payment was sent.`,
          { provider: request.providerId, status: answer.status },
        );
      }

      return ok({
        quote,
        status: answer.status,
        body: answer.body,
        bodyHash: config.hash(answer.rawText),
        amountPaid: quote.amount,
        settlement: parseSettlement(answer.getHeader),
      });
    },
  };
}
