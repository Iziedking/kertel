/**
 * One-use confirmation codes.
 *
 * A natural-language "yes" is ambiguous: it can be a reply to the wrong
 * message, a forward, or an answer to a question the user misread. A code names
 * one specific order, expires, works once, and is bound to one sender. That is
 * what makes the audit trail mean something after the fact.
 *
 * Kertel stores only the hash. The plaintext exists in the outbound WhatsApp
 * message and in the user's chat, nowhere else, so a leaked database cannot be
 * used to confirm anything.
 */

import { KertelDefect } from "../domain/result.js";
import type { Instant, Seconds } from "../domain/time.js";
import { addSeconds } from "../domain/time.js";
import type { ConfirmationToken, ProposalId, SenderIdHash } from "../domain/types.js";
import type { Hasher } from "../proposals/hash.js";

/** Injected so the core stays dependency-free and a test can make codes predictable. */
export type RandomBytes = (count: number) => Uint8Array;

export const CODE_PREFIX = "KTL";
const CODE_LENGTH = 6;

/**
 * Crockford base32 without the characters people mistype on a phone keyboard:
 * no 0/O, no 1/I/L, no U. 32 symbols over 6 places is about 1.07 billion codes.
 *
 * Sender binding already means a stranger cannot use a code even with the right
 * digits, so this is defence in depth rather than the primary control. It costs
 * two extra characters of typing and removes guessing from the threat model.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ*+";

if (ALPHABET.length !== 32) {
  throw new KertelDefect(`confirmation alphabet must hold 32 symbols, holds ${String(ALPHABET.length)}`);
}

/**
 * Draw a code without modulo bias.
 *
 * Taking `byte % 32` would be fine for a 32-symbol alphabet over 256 values,
 * but the masking form stays correct if the alphabet ever changes size, and a
 * biased confirmation code is the kind of defect nobody notices.
 */
export function generateConfirmationCode(random: RandomBytes): string {
  const symbols: string[] = [];
  while (symbols.length < CODE_LENGTH) {
    const bytes = random(CODE_LENGTH);
    if (bytes.length !== CODE_LENGTH) {
      throw new KertelDefect(
        `random source returned ${String(bytes.length)} bytes, expected ${String(CODE_LENGTH)}`,
      );
    }
    for (const byte of bytes) {
      if (symbols.length >= CODE_LENGTH) {
        break;
      }
      const index = byte & 0b0001_1111;
      const symbol = ALPHABET[index];
      if (symbol === undefined) {
        throw new KertelDefect(`alphabet index ${String(index)} is out of range`);
      }
      symbols.push(symbol);
    }
  }
  return `${CODE_PREFIX}-${symbols.join("")}`;
}

/**
 * Read a code out of whatever the user actually typed.
 *
 * Accepts `confirm ktl-7f3k9q`, `CONFIRM KTL7F3K9Q`, and a bare code. Rejects
 * anything else rather than guessing, because a guess here authorises a trade.
 * Case and the separating hyphen are forgiven; the symbols are not.
 */
export function normalizeConfirmationCode(input: string): string | null {
  const stripped = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  const withoutVerb = stripped.startsWith("CONFIRM")
    ? stripped.slice("CONFIRM".length)
    : stripped.startsWith("CANCEL")
      ? stripped.slice("CANCEL".length)
      : stripped;

  if (!withoutVerb.startsWith(CODE_PREFIX)) {
    return null;
  }
  const symbols = withoutVerb.slice(CODE_PREFIX.length);
  if (symbols.length !== CODE_LENGTH) {
    return null;
  }
  for (const symbol of symbols) {
    if (!ALPHABET.includes(symbol)) {
      return null;
    }
  }
  return `${CODE_PREFIX}-${symbols}`;
}

/**
 * Hash a code for storage and lookup.
 *
 * The proposal hash is mixed in so the same plaintext code issued for two
 * different proposals stores as two different rows. Without it, an old code
 * could be looked up against a newer proposal.
 */
export function hashConfirmationCode(input: {
  readonly code: string;
  readonly proposalHash: string;
  readonly hash: Hasher;
}): string {
  const normalized = normalizeConfirmationCode(input.code);
  if (normalized === null) {
    throw new KertelDefect("cannot hash a code that is not well formed");
  }
  return input.hash(`kertel.confirmation.v1\n${input.proposalHash}\n${normalized}`);
}

export type IssuedConfirmation = {
  /** Shown to the user once, in the proposal message. Never stored. */
  readonly code: string;
  readonly token: ConfirmationToken;
};

export function issueConfirmationToken(input: {
  readonly proposalId: ProposalId;
  readonly proposalHash: string;
  readonly senderIdHash: SenderIdHash;
  readonly now: Instant;
  readonly ttl: Seconds;
  readonly random: RandomBytes;
  readonly hash: Hasher;
}): IssuedConfirmation {
  if (input.ttl <= 0) {
    throw new KertelDefect("a confirmation token needs a positive time to live");
  }
  const code = generateConfirmationCode(input.random);
  const tokenHash = hashConfirmationCode({
    code,
    proposalHash: input.proposalHash,
    hash: input.hash,
  });

  return {
    code,
    token: {
      tokenHash,
      proposalId: input.proposalId,
      proposalHash: input.proposalHash,
      senderIdHash: input.senderIdHash,
      issuedAt: input.now,
      expiresAt: addSeconds(input.now, input.ttl),
      consumedAt: null,
      status: "active",
    },
  };
}

/**
 * Mark a token used.
 *
 * The caller must have passed `evaluateConfirmation` first. This function does
 * not re-judge; it records. Splitting them keeps the decision in one place
 * where every branch is tested, instead of half here and half in the gate.
 */
export function consumeConfirmationToken(
  token: ConfirmationToken,
  now: Instant,
): ConfirmationToken {
  if (token.status !== "active" || token.consumedAt !== null) {
    throw new KertelDefect(
      `refusing to consume a token in status ${token.status}; the confirmation gate should have caught this`,
    );
  }
  return { ...token, status: "consumed", consumedAt: now };
}

export function revokeConfirmationToken(token: ConfirmationToken): ConfirmationToken {
  return token.status === "consumed" ? token : { ...token, status: "revoked" };
}
