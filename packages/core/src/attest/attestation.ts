/** Signed statements. Offline checks establish signature integrity only. */
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
  readonly binding?: { readonly researchRunId: string; readonly decisionDigest: string; readonly proposalHash: string };
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
    attestation.binding ? "TELT-ATTESTATION-2" : ATTESTATION_VERSION,
    `symbol=${attestation.symbol}`,
    `goal=${attestation.goal}`,
    `at=${attestation.at}`,
    `agent=${attestation.agent.toLowerCase()}`,
    `provenance=${attestation.provenance}`,
    `spent=${fp.format(attestation.spent)}`,
    `decision=${attestation.decision}`,
    `order=${attestation.order ?? "none"}`,
    ...(attestation.binding ? [`researchRunId=${attestation.binding.researchRunId}`, `decisionDigest=${attestation.binding.decisionDigest}`, `proposalHash=${attestation.binding.proposalHash}`] : []),
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
  if (text.length > 64000) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/^[>|\s]+/, ""))
    .filter((line) => line !== "");

  const start = lines.findIndex(line => line === ATTESTATION_VERSION || line === "TELT-ATTESTATION-2");
  if (start === -1) return null;

  // Exactly one attestation, ending where the next begins. Without this bound
  // the repeatable `payment=` lines accumulate across both, producing a record
  // that nobody signed and that therefore fails for a confusing reason.
  const after = lines.findIndex((line, i) => i > start && (line === ATTESTATION_VERSION || line === "TELT-ATTESTATION-2"));
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
    } else {
      if (fields.has(key)) return null;
      fields.set(key, value);
    }
    if (key === "sig") break;
  }

  const required = ["symbol", "goal", "at", "agent", "provenance", "spent", "decision", "sig"];
  for (const key of required) {
    if (!fields.has(key)) return null;
  }

  const isV2 = lines[start] === "TELT-ATTESTATION-2";
  if (isV2 && ["researchRunId", "decisionDigest", "proposalHash"].some(key => !fields.get(key))) return null;
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
      ...(isV2 ? { binding: { researchRunId: fields.get("researchRunId")!, decisionDigest: fields.get("decisionDigest")!, proposalHash: fields.get("proposalHash")! } } : {}),
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
            detail: `Signed by ${claimed}. This verifies the signature against the claimed address, not the identity or payment.`,
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
    status: "info",
    detail:
      paid.length > 0
        ? `${String(paid.length)} claimed payment reference(s). Not checked against the chain. A reference alone does not prove a payment or delivery.`
        : "No payment is claimed. This signature does not prove which sources were read.",
  });

  checks.push({
    name: "order",
    status: "info",
    detail:
      signed.attestation.order === null
        ? "Research only. No order is claimed against this evidence."
        : `Order ${signed.attestation.order} is claimed, not verified. Only the account holder can check it against Binance.`,
  });

  checks.push({ name: "evidence content", status: "info", detail: "The evidence digest is signed. The original provider payloads and their origin have not been verified." });
  checks.push({ name: "research timing", status: "info", detail: "The stated time is not independently timestamped. A payment block time does not date this off-chain decision." });
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
  const lines: string[] = ["Signed evidence receipt"];

  const paid = signed.attestation.payments.filter((payment) => payment.transaction !== null);
  if (paid.length === 0) {
    lines.push(
      "  Nothing was bought for this, so there is no payment to check. The signature below still " +
        "identifies the signing key and the claims it signed. It does not authenticate those claims.",
    );
  } else {
    lines.push(
      `  Claimed research spend: ${fp.format(signed.attestation.spent)} USD equivalent. ` +
        "Payment references below require independent verification:",
    );
    for (const payment of paid) {
      const url = explorerUrl(payment);
      lines.push(
        `    ${payment.provider} ${fp.format(payment.amount)} on ${payment.network}` +
          (url === null ? ` tx ${payment.transaction ?? ""}` : `\n      ${url}`),
      );
    }
    lines.push(
      `  Claimed payer and signer: ${signed.attestation.agent.toLowerCase()}. ` +
        "The signature alone does not verify payment, source authenticity, or pre-trade timing.",
    );
  }

  lines.push("");
  lines.push("  Verify with telt_verify, or at https://telt.site/verify");
  lines.push("");
  lines.push(serialize(signed));

  return lines.join("\n");
}
