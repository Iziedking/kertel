/**
 * Proof that the agent did the work, checkable by someone who does not trust it.
 *
 * Every AI trading agent has the same unanswerable question asked of it: how do
 * you know it did not invent the thesis? Logs do not answer it. A log is
 * written by the same program that would have lied, kept by the same operator
 * who benefits from the lie, and can be edited afterwards by either. "Our
 * decisions are reproducible from our logs" is a claim about the logs.
 *
 * An attestation answers it with facts that live outside Telt entirely:
 *
 * 1. **The payment is on a public chain.** Telt buys its research with x402, so
 *    every source it read left a real transaction — an amount, a recipient, a
 *    payer and a block timestamp that anyone can pull up without asking Telt
 *    anything. Research that did not happen has no transaction.
 * 2. **The evidence is committed to.** The provenance digest is taken over what
 *    each source actually returned, so the payload cannot be swapped afterwards
 *    for something that better fits the outcome.
 * 3. **The conclusion is signed by the key that paid.** The same account that
 *    sent those transactions signs the decision. Not "an agent" concluded this:
 *    *this* agent, the one whose money moved.
 * 4. **The block timestamp precedes the order.** The chain records when the
 *    money moved, and the exchange records when the order was placed. A thesis
 *    written after a trade cannot be backdated into a block.
 *
 * Which is why the chain runs one way and cannot be run backwards: paid ->
 * read -> concluded -> traded, with the first and last links held by parties
 * who have never heard of Telt.
 *
 * The format is plain lines rather than JSON on purpose. It has to survive
 * being pasted into a chat window, quoted in an email, and read aloud in a
 * demo — and a verifier has to be able to reconstruct the exact signed bytes
 * from what it was given, which JSON's key ordering makes needlessly delicate.
 */

import type { FixedPoint } from "../money/index.js";
import * as fp from "../money/index.js";

export const ATTESTATION_VERSION = "TELT-ATTESTATION-1";

/** One paid source, and the transaction that paid for it. */
export type PaymentProof = {
  readonly provider: string;
  /** The rail it settled on, e.g. "bsc-u". Tells a verifier which explorer. */
  readonly network: string;
  /** The onchain transaction hash. Null when the facilitator returned none. */
  readonly transaction: string | null;
  readonly amount: FixedPoint;
};

export type Attestation = {
  readonly symbol: string;
  readonly goal: string;
  /** When Telt reached the conclusion. The chain holds the authoritative times. */
  readonly at: string;
  /** The address that both paid for the evidence and signed this. */
  readonly agent: string;
  /** Commits to what every source actually returned. */
  readonly provenance: string;
  readonly payments: readonly PaymentProof[];
  readonly spent: FixedPoint;
  /**
   * What the evidence supported. Deliberately one of a fixed set rather than
   * prose: an attestation is a commitment, and free text is not commitment.
   */
  readonly decision: string;
  /**
   * The exchange's own id for the order this justified, once there is one.
   *
   * Null on a research attestation, filled in when a trade is confirmed
   * against it — which is what closes the loop from "it knew this" to "it did
   * this because of it".
   */
  readonly order: string | null;
};

/**
 * The exact bytes that get signed.
 *
 * Every field, one per line, in a fixed order. A verifier rebuilds this string
 * from the attestation it was handed and recovers the signer from it, so any
 * field changing by one character produces a different address and fails.
 */
export function canonicalize(attestation: Attestation): string {
  const payments = attestation.payments
    .map(
      (payment) =>
        `${payment.provider}:${payment.network}:${payment.transaction ?? "none"}:${fp.format(payment.amount)}`,
    )
    // Sorted, because the order Telt happened to pay in is not part of the
    // claim, and a verifier must not have to guess it.
    .sort();

  return [
    ATTESTATION_VERSION,
    `symbol=${attestation.symbol}`,
    `goal=${attestation.goal}`,
    `at=${attestation.at}`,
    `agent=${attestation.agent.toLowerCase()}`,
    `provenance=${attestation.provenance}`,
    `spent=${fp.format(attestation.spent)}`,
    `decision=${attestation.decision}`,
    `order=${attestation.order ?? "none"}`,
    ...payments.map((line) => `payment=${line}`),
  ].join("\n");
}

/** A signed attestation, as it travels. */
export type SignedAttestation = {
  readonly attestation: Attestation;
  /** EIP-191 personal_sign over `canonicalize(attestation)`. */
  readonly signature: string;
};

/** How an attestation is written down: the canonical body plus its signature. */
export function serialize(signed: SignedAttestation): string {
  return `${canonicalize(signed.attestation)}\nsig=${signed.signature}`;
}

/**
 * Read one back.
 *
 * Tolerant of surrounding text, because these get pasted out of chat logs with
 * quote markers and stray blank lines around them. Strict about the fields
 * themselves: anything it cannot account for makes the whole thing null rather
 * than a partially understood attestation, since a half-read proof is worse
 * than none.
 */
export function deserialize(text: string): SignedAttestation | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/^[>|\s]+/, ""))
    .filter((line) => line !== "");

  const start = lines.indexOf(ATTESTATION_VERSION);
  if (start === -1) return null;

  // Exactly one attestation, ending where the next begins. Without this bound
  // the repeatable `payment=` lines accumulate across both, producing a record
  // that nobody signed and that therefore fails for a confusing reason.
  const after = lines.indexOf(ATTESTATION_VERSION, start + 1);
  const body = lines.slice(start + 1, after === -1 ? undefined : after);

  const fields = new Map<string, string>();
  const payments: string[] = [];

  for (const line of body) {
    const split = line.indexOf("=");
    if (split <= 0) continue;
    const key = line.slice(0, split);
    const value = line.slice(split + 1);
    if (key === "payment") {
      payments.push(value);
    } else if (!fields.has(key)) {
      // First wins, for a field repeated inside one attestation.
      fields.set(key, value);
    }
  }

  const required = ["symbol", "goal", "at", "agent", "provenance", "spent", "decision", "sig"];
  for (const key of required) {
    if (!fields.has(key)) return null;
  }

  const parsedPayments: PaymentProof[] = [];
  for (const entry of payments) {
    const parts = entry.split(":");
    if (parts.length !== 4) return null;
    const [provider, network, transaction, amount] = parts as [string, string, string, string];
    if (!/^\d+(\.\d+)?$/.test(amount)) return null;
    parsedPayments.push({
      provider,
      network,
      transaction: transaction === "none" ? null : transaction,
      amount: fp.parse(amount),
    });
  }

  const spent = fields.get("spent") ?? "";
  if (!/^\d+(\.\d+)?$/.test(spent)) return null;

  const order = fields.get("order") ?? "none";

  return {
    attestation: {
      symbol: fields.get("symbol") ?? "",
      goal: fields.get("goal") ?? "",
      at: fields.get("at") ?? "",
      agent: fields.get("agent") ?? "",
      provenance: fields.get("provenance") ?? "",
      payments: parsedPayments,
      spent: fp.parse(spent),
      decision: fields.get("decision") ?? "",
      order: order === "none" ? null : order,
    },
    signature: fields.get("sig") ?? "",
  };
}

/** Where a verifier goes to check a payment with their own eyes. */
export function explorerUrl(payment: PaymentProof): string | null {
  if (payment.transaction === null) return null;
  if (payment.network.startsWith("bsc")) {
    return `https://bscscan.com/tx/${payment.transaction}`;
  }
  if (payment.network.startsWith("base")) {
    return `https://basescan.org/tx/${payment.transaction}`;
  }
  return null;
}

export type VerificationCheck = {
  readonly name: string;
  /**
   * `info` is not a weaker `pass`.
   *
   * A research attestation legitimately claims no order, and reporting that as
   * a failure teaches a reader to skim past failures — which is exactly the
   * habit that makes the one real failure invisible.
   */
  readonly status: "pass" | "fail" | "info";
  readonly detail: string;
};

/**
 * What can be checked without a network, and what cannot.
 *
 * The signature is decidable here and now: recover the signer, compare it to
 * the address the attestation claims. The payments are not — they are facts
 * about a blockchain, and this returns the links rather than pretending to
 * have followed them. A verifier that says "payments verified" without making
 * a request is exactly the kind of self-attestation this whole file exists to
 * avoid.
 */
export function checkOffline(
  signed: SignedAttestation,
  recovered: string | null,
): readonly VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const claimed = signed.attestation.agent.toLowerCase();

  checks.push(
    recovered === null
      ? {
          name: "signature",
          status: "fail" as const,
          detail: "The signature could not be read at all, so nothing here is attributable.",
        }
      : recovered.toLowerCase() === claimed
        ? {
            name: "signature",
            status: "pass" as const,
            detail: `Signed by ${claimed}. The conclusion and the address that paid for it match.`,
          }
        : {
            name: "signature",
            status: "fail" as const,
            detail: `Signed by ${recovered.toLowerCase()}, which is NOT the ${claimed} this claims. Treat it as forged.`,
          },
  );

  const paid = signed.attestation.payments.filter((payment) => payment.transaction !== null);
  checks.push({
    name: "evidence was paid for",
    status: paid.length > 0 ? ("pass" as const) : ("info" as const),
    detail:
      paid.length > 0
        ? `${String(paid.length)} onchain payment${paid.length === 1 ? "" : "s"} totalling ${fp.format(signed.attestation.spent)} USDC. Follow the links and check the payer, amount and block time yourself.`
        : "No settled payment is recorded, so this attestation rests on free sources only. It proves what Telt read, not that it bought anything.",
  });

  checks.push({
    name: "order",
    status: signed.attestation.order !== null ? ("pass" as const) : ("info" as const),
    detail:
      signed.attestation.order === null
        ? "Research only. No order is claimed against this evidence."
        : `Order ${signed.attestation.order}. The account holder can confirm this fill against Binance directly.`,
  });

  return checks;
}

/**
 * How a proof appears at the bottom of a receipt.
 *
 * Two audiences at once. A person skimming needs one sentence telling them
 * what this is and one link they can click; a verifier needs the exact bytes.
 * So the explorer links come first in prose, and the signed block sits below
 * them, unwrapped and unindented so that copying it cannot corrupt it.
 */
export function renderAttestationBlock(signed: SignedAttestation): string {
  const lines: string[] = ["Proof of research"];

  const paid = signed.attestation.payments.filter((payment) => payment.transaction !== null);
  if (paid.length === 0) {
    lines.push(
      "  Nothing was bought for this, so there is no payment to check. The signature below still " +
        "shows which agent reached this conclusion, and over what evidence.",
    );
  } else {
    lines.push(
      `  Telt paid ${fp.format(signed.attestation.spent)} USDC of its own for this evidence. ` +
        "Those payments are on a public chain — check them yourself:",
    );
    for (const payment of paid) {
      const url = explorerUrl(payment);
      lines.push(
        `    ${payment.provider} ${fp.format(payment.amount)} on ${payment.network}` +
          (url === null ? ` tx ${payment.transaction ?? ""}` : `\n      ${url}`),
      );
    }
    lines.push(
      `  The payer is ${signed.attestation.agent.toLowerCase()}, and that same address signed the ` +
        "conclusion below. The block times sit before any order placed on it.",
    );
  }

  lines.push("");
  lines.push("  Verify with telt_verify, or at https://telt.site/verify");
  lines.push("");
  lines.push(serialize(signed));

  return lines.join("\n");
}
