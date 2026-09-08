/** Signed statements. Offline checks establish signature integrity only. */
import type { FixedPoint } from "../money/index.js";
export declare const ATTESTATION_VERSION = "TELT-ATTESTATION-1";
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
    readonly binding?: {
        readonly researchRunId: string;
        readonly decisionDigest: string;
        readonly proposalHash: string;
    };
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
export declare function canonicalize(attestation: Attestation): string;
/** A signed attestation, as it travels. */
export type SignedAttestation = {
    readonly attestation: Attestation;
    /** EIP-191 personal_sign over `canonicalize(attestation)`. */
    readonly signature: string;
};
/** How an attestation is written down: the canonical body plus its signature. */
export declare function serialize(signed: SignedAttestation): string;
/**
 * Read one back.
 *
 * Tolerant of surrounding text, because these get pasted out of chat logs with
 * quote markers and stray blank lines around them. Strict about the fields
 * themselves: anything it cannot account for makes the whole thing null rather
 * than a partially understood attestation, since a half-read proof is worse
 * than none.
 */
export declare function deserialize(text: string): SignedAttestation | null;
/** Where a verifier goes to check a payment with their own eyes. */
export declare function explorerUrl(payment: PaymentProof): string | null;
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
export declare function checkOffline(signed: SignedAttestation, recovered: string | null): readonly VerificationCheck[];
/**
 * How a proof appears at the bottom of a receipt.
 *
 * Two audiences at once. A person skimming needs one sentence telling them
 * what this is and one link they can click; a verifier needs the exact bytes.
 * So the explorer links come first in prose, and the signed block sits below
 * them, unwrapped and unindented so that copying it cannot corrupt it.
 */
export declare function renderAttestationBlock(signed: SignedAttestation): string;
