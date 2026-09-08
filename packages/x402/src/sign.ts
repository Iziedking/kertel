/**
 * Signing an attestation with the same key that paid for the evidence.
 *
 * That the key is the same one is the entire point, and it is why this lives
 * here rather than in core. The x402 wallet is the account whose transactions
 * appear on BscScan next to each provider payment. When it also signs the
 * conclusion, a verifier can tie the two together without trusting anything
 * Telt says: the address that spent the money is the address that authored the
 * thesis, and neither fact comes from Telt.
 *
 * EIP-191 (`personal_sign`), not a bare hash signature, because it is what
 * every wallet, block explorer and verification tool already implements. A
 * proof nobody can check with tools they already have is not much of a proof.
 */

import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

import { canonicalize } from "@telt/core/attest";
import type { Attestation, SignedAttestation } from "@telt/core/attest";

export type Signer = {
  /** The address that signs, and that pays for research. */
  readonly address: string;
  sign(attestation: Attestation): Promise<SignedAttestation>;
};

/**
 * A signer from the research wallet's key.
 *
 * Returns null when no wallet is configured, and the caller must treat that as
 * "no attestation" rather than falling back to an unsigned one. An unsigned
 * attestation looks exactly like a signed one to a reader skimming it, which
 * makes it worse than nothing.
 */
export function createSigner(privateKey: string | undefined): Signer | null {
  const trimmed = privateKey?.trim();
  if (trimmed === undefined || trimmed === "") {
    return null;
  }

  const account = privateKeyToAccount(trimmed as `0x${string}`);

  return {
    address: account.address,
    async sign(attestation: Attestation): Promise<SignedAttestation> {
      // Signed over the canonical form, never over the rendered receipt: the
      // wording of a receipt may change between versions, and a proof that
      // breaks when a label is reworded is a proof nobody will keep.
      const signature = await account.signMessage({ message: canonicalize(attestation) });
      return { attestation, signature };
    },
  };
}

/**
 * Who actually signed this.
 *
 * Returns null rather than throwing on a malformed signature, because a
 * verifier is by definition being handed input from someone it does not trust,
 * and "this did not parse" is an ordinary answer there rather than an error.
 */
export async function recoverSigner(signed: SignedAttestation): Promise<string | null> {
  try {
    return await recoverMessageAddress({
      message: canonicalize(signed.attestation),
      signature: signed.signature as `0x${string}`,
    });
  } catch {
    return null;
  }
}
