import { describe, expect, it } from "vitest";

import { KertelDefect } from "../src/domain/result.js";
import { seconds } from "../src/domain/time.js";
import type { ProposalId } from "../src/domain/types.js";
import {
  consumeConfirmationToken,
  generateConfirmationCode,
  hashConfirmationCode,
  issueConfirmationToken,
  normalizeConfirmationCode,
  revokeConfirmationToken,
} from "../src/confirmation/token.js";
import { at, OWNER, T0, token } from "./builders.js";

const fakeHash = (input: string): string => `hash(${input.replace(/\n/g, "|")})`;

/** A random source a test can steer, so a code is a fact rather than a surprise. */
function fixedRandom(...bytes: number[]): (count: number) => Uint8Array {
  return (count) => Uint8Array.from(Array.from({ length: count }, (_, i) => bytes[i % bytes.length] ?? 0));
}

describe("code generation", () => {
  it("produces a prefixed, fixed-length code", () => {
    const code = generateConfirmationCode(fixedRandom(0, 1, 2, 3, 4, 5));
    expect(code).toMatch(/^KTL-[23456789ABCDEFGHJKMNPQRSTVWXYZ*+]{6}$/);
  });

  it("maps a byte through the low five bits, so the alphabet is used evenly", () => {
    // 0 -> "2", 1 -> "3", 31 -> "+". Byte 32 wraps to index 0 again.
    expect(generateConfirmationCode(fixedRandom(0))).toBe("KTL-222222");
    expect(generateConfirmationCode(fixedRandom(31))).toBe("KTL-++++++");
    expect(generateConfirmationCode(fixedRandom(32))).toBe("KTL-222222");
  });

  it("omits the characters people mistype on a phone", () => {
    // Only the symbol half is drawn from the alphabet. The fixed "KTL-" prefix
    // is there to make the code recognisable in a chat and is not a symbol.
    const symbols = generateConfirmationCode(
      fixedRandom(...Array.from({ length: 32 }, (_, i) => i)),
    ).slice("KTL-".length);
    for (const confusable of ["0", "O", "1", "I", "L", "U"]) {
      expect(symbols, confusable).not.toContain(confusable);
    }
  });

  it("refuses a random source that short-changes it rather than padding", () => {
    const starved = (): Uint8Array => Uint8Array.from([1, 2]);
    expect(() => generateConfirmationCode(starved)).toThrow(KertelDefect);
  });
});

describe("reading what the user typed", () => {
  it("accepts the exact form", () => {
    expect(normalizeConfirmationCode("KTL-7F3K9Q")).toBe("KTL-7F3K9Q");
  });

  it("forgives case, spacing and the hyphen", () => {
    for (const typed of [
      "confirm ktl-7f3k9q",
      "CONFIRM KTL7F3K9Q",
      "  Confirm   KTL - 7F3K9Q  ",
      "ktl7f3k9q",
      "KTL-7f3k9q",
    ]) {
      expect(normalizeConfirmationCode(typed), typed).toBe("KTL-7F3K9Q");
    }
  });

  it("reads a cancel the same way, so cancelling cannot be misread as confirming", () => {
    expect(normalizeConfirmationCode("cancel ktl-7f3k9q")).toBe("KTL-7F3K9Q");
  });

  it("refuses anything it would have to guess at", () => {
    for (const typed of [
      "yes",
      "yes please go ahead",
      "confirm",
      "KTL-",
      "KTL-7F3K9",
      "KTL-7F3K9QQ",
      "KTL-7F3K9O",
      "KTL-7F3K91",
      "ABC-7F3K9Q",
      "",
      "   ",
    ]) {
      expect(normalizeConfirmationCode(typed), JSON.stringify(typed)).toBeNull();
    }
  });
});

describe("hashing a code", () => {
  it("binds the hash to one proposal, so the same code cannot cross over", () => {
    const first = hashConfirmationCode({
      code: "KTL-7F3K9Q",
      proposalHash: "sha256:proposal-a",
      hash: fakeHash,
    });
    const second = hashConfirmationCode({
      code: "KTL-7F3K9Q",
      proposalHash: "sha256:proposal-b",
      hash: fakeHash,
    });
    expect(first).not.toBe(second);
  });

  it("hashes the normalised form, so how the user typed it does not matter", () => {
    const typed = hashConfirmationCode({
      code: "  confirm ktl-7f3k9q ",
      proposalHash: "sha256:proposal-a",
      hash: fakeHash,
    });
    const exact = hashConfirmationCode({
      code: "KTL-7F3K9Q",
      proposalHash: "sha256:proposal-a",
      hash: fakeHash,
    });
    expect(typed).toBe(exact);
  });

  it("refuses to hash a code it could not parse", () => {
    expect(() =>
      hashConfirmationCode({ code: "yes", proposalHash: "sha256:proposal-a", hash: fakeHash }),
    ).toThrow(KertelDefect);
  });
});

describe("issuing a token", () => {
  const issue = () =>
    issueConfirmationToken({
      proposalId: "prop-1" as ProposalId,
      proposalHash: "sha256:proposal",
      senderIdHash: OWNER,
      now: T0,
      ttl: seconds(120),
      random: fixedRandom(0, 1, 2, 3, 4, 5),
      hash: fakeHash,
    });

  it("returns the plaintext once and keeps no field holding it", () => {
    // `fakeHash` echoes its input on purpose, so this cannot assert that the
    // digest hides the code; that is a property of sha-256, not of this module.
    // What is this module's job is that the stored token carries no plaintext
    // field of its own, so nothing but the digest ever reaches SQLite.
    const issued = issue();
    expect(issued.code).toBe("KTL-234567");
    expect(Object.keys(issued.token)).not.toContain("code");
    expect(Object.values(issued.token)).not.toContain(issued.code);
  });

  it("produces a digest that changes with the code", () => {
    const first = issue();
    const second = issueConfirmationToken({
      proposalId: "prop-1" as ProposalId,
      proposalHash: "sha256:proposal",
      senderIdHash: OWNER,
      now: T0,
      ttl: seconds(120),
      random: fixedRandom(9, 9, 9, 9, 9, 9),
      hash: fakeHash,
    });
    expect(second.code).not.toBe(first.code);
    expect(second.token.tokenHash).not.toBe(first.token.tokenHash);
  });

  it("binds the token to the sender and the proposal", () => {
    const issued = issue();
    expect(issued.token.senderIdHash).toBe(OWNER);
    expect(issued.token.proposalId).toBe("prop-1");
    expect(issued.token.proposalHash).toBe("sha256:proposal");
  });

  it("expires exactly one time-to-live after issue", () => {
    const issued = issue();
    expect(issued.token.issuedAt).toBe(T0);
    expect(issued.token.expiresAt).toBe(at(120));
    expect(issued.token.status).toBe("active");
    expect(issued.token.consumedAt).toBeNull();
  });

  it("refuses a token that would never be valid", () => {
    expect(() =>
      issueConfirmationToken({
        proposalId: "prop-1" as ProposalId,
        proposalHash: "sha256:proposal",
        senderIdHash: OWNER,
        now: T0,
        ttl: seconds(0),
        random: fixedRandom(1),
        hash: fakeHash,
      }),
    ).toThrow(KertelDefect);
  });

  it("stores a hash that a later lookup can reproduce from the typed code", () => {
    const issued = issue();
    const lookedUp = hashConfirmationCode({
      code: `confirm ${issued.code.toLowerCase()}`,
      proposalHash: "sha256:proposal",
      hash: fakeHash,
    });
    expect(lookedUp).toBe(issued.token.tokenHash);
  });
});

describe("consuming and revoking", () => {
  it("marks the token used at the instant it was used", () => {
    const consumed = consumeConfirmationToken(token(), at(30));
    expect(consumed.status).toBe("consumed");
    expect(consumed.consumedAt).toBe(at(30));
  });

  it("treats a second consume as a defect, because the gate should have refused it", () => {
    const consumed = consumeConfirmationToken(token(), at(30));
    expect(() => consumeConfirmationToken(consumed, at(31))).toThrow(KertelDefect);
  });

  it("refuses to consume a revoked token", () => {
    expect(() => consumeConfirmationToken(token({ status: "revoked" }), at(30))).toThrow(KertelDefect);
  });

  it("revokes an active token, which is what `stop` does to every outstanding code", () => {
    expect(revokeConfirmationToken(token()).status).toBe("revoked");
  });

  it("leaves an already-used token alone rather than rewriting history", () => {
    const consumed = consumeConfirmationToken(token(), at(30));
    const revoked = revokeConfirmationToken(consumed);
    expect(revoked.status).toBe("consumed");
    expect(revoked.consumedAt).toBe(at(30));
  });
});
