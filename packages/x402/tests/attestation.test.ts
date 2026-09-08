/**
 * The proof has to survive being handled by people.
 *
 * An attestation is pasted out of a chat window, quoted in an email with `>`
 * markers down the side, reflowed by something helpful, and read by a verifier
 * that has never seen Telt. These tests are about that journey, and about the
 * one thing that must never happen: a tampered attestation that still verifies.
 */

import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { canonicalize, checkOffline, deserialize, explorerUrl, serialize } from "@telt/core/attest";
import type { Attestation } from "@telt/core/attest";

import { createSigner, recoverSigner } from "../src/sign.js";

/** A throwaway key. It signs test attestations and nothing else. */
const KEY = `0x${"a".repeat(64)}`;

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    symbol: "ETHUSDT",
    goal: "trade_thesis",
    at: "2026-09-08T02:40:00.000Z",
    agent: "0xD2F6393c6A916Acb98057a5920952084B838cfd1",
    provenance: "f06563e482895e5044bc63e7ab41c2b117142e4c2abfe3cb5bacf38fa4830015",
    payments: [
      {
        provider: "nansen",
        network: "bsc-u",
        transaction: "0xabc123",
        amount: fp.parse("0.05"),
      },
      {
        provider: "coingecko",
        network: "base-usdc",
        transaction: "0xdef456",
        amount: fp.parse("0.01"),
      },
    ],
    spent: fp.parse("0.06"),
    decision: "BUY_CANDIDATE",
    order: null,
    ...overrides,
  };
}

describe("signing an attestation", () => {
  it("is signed by the address that paid for the evidence", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");

    const signed = await signer.sign(attestation({ agent: signer.address }));
    const recovered = await recoverSigner(signed);

    expect(recovered?.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("has no signer at all without a wallet, rather than an unsigned proof", () => {
    // An unsigned attestation reads exactly like a signed one to someone
    // skimming it, which makes it worse than having none.
    expect(createSigner(undefined)).toBeNull();
    expect(createSigner("   ")).toBeNull();
  });
});

describe("what a verifier can catch", () => {
  it("rejects a changed conclusion", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const signed = await signer.sign(attestation({ agent: signer.address }));

    // The tamper that matters: the evidence stays, the verdict flips.
    const tampered = {
      ...signed,
      attestation: { ...signed.attestation, decision: "NO_TRADE" },
    };

    const recovered = await recoverSigner(tampered);
    expect(recovered?.toLowerCase()).not.toBe(signer.address.toLowerCase());

    const checks = checkOffline(tampered, recovered);
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.detail).toContain("forged");
  });

  it("rejects evidence swapped under a conclusion", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const signed = await signer.sign(attestation({ agent: signer.address }));

    const tampered = {
      ...signed,
      attestation: { ...signed.attestation, provenance: "0".repeat(64) },
    };

    expect((await recoverSigner(tampered))?.toLowerCase()).not.toBe(signer.address.toLowerCase());
  });

  it("rejects a payment amount edited upward", async () => {
    // Claiming more research than was bought is the flattering lie, so it is
    // the one worth being certain about.
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const signed = await signer.sign(attestation({ agent: signer.address }));

    const tampered = {
      ...signed,
      attestation: {
        ...signed.attestation,
        payments: [
          { ...signed.attestation.payments[0]!, amount: fp.parse("5.00") },
          signed.attestation.payments[1]!,
        ],
      },
    };

    expect((await recoverSigner(tampered))?.toLowerCase()).not.toBe(signer.address.toLowerCase());
  });

  it("catches an attestation reassigned to another agent", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const signed = await signer.sign(attestation({ agent: signer.address }));

    const stolen = {
      ...signed,
      attestation: { ...signed.attestation, agent: "0x000000000000000000000000000000000000dead" },
    };

    const checks = checkOffline(stolen, await recoverSigner(stolen));
    expect(checks[0]?.status).toBe("fail");
  });
});

describe("surviving being handled", () => {
  it("round-trips through text", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const signed = await signer.sign(attestation({ agent: signer.address }));

    const parsed = deserialize(serialize(signed));
    expect(parsed).not.toBeNull();
    expect((await recoverSigner(parsed!))?.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("survives being quoted in an email and padded with chatter", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const signed = await signer.sign(attestation({ agent: signer.address }));

    const mangled = [
      "Hi, is this real? It says:",
      "",
      ...serialize(signed)
        .split("\n")
        .map((line) => `> ${line}`),
      "",
      "Thanks",
    ].join("\n");

    const parsed = deserialize(mangled);
    expect(parsed).not.toBeNull();
    expect((await recoverSigner(parsed!))?.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("does not care what order the payments arrive in", async () => {
    // Telt pays in whatever order the planner ran. That is not part of the
    // claim, so a verifier must not have to reproduce it.
    const one = attestation();
    const other = attestation({ payments: [...one.payments].reverse() });
    expect(canonicalize(one)).toBe(canonicalize(other));
  });

  it("refuses to half-read a truncated attestation", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const text = serialize(await signer.sign(attestation({ agent: signer.address })));

    // Cut off mid-way, as a chat client would when it elides a long message.
    const truncated = text.split("\n").slice(0, 4).join("\n");
    expect(deserialize(truncated)).toBeNull();
  });

  it("takes the first attestation when two are pasted together", async () => {
    const signer = createSigner(KEY);
    if (signer === null) throw new Error("expected a signer");
    const first = await signer.sign(attestation({ agent: signer.address, symbol: "ETHUSDT" }));
    const second = await signer.sign(attestation({ agent: signer.address, symbol: "BTCUSDT" }));

    const parsed = deserialize(`${serialize(first)}\n${serialize(second)}`);
    // Mixing fields from both would produce one nobody ever signed.
    expect(parsed?.attestation.symbol).toBe("ETHUSDT");
    expect((await recoverSigner(parsed!))?.toLowerCase()).toBe(signer.address.toLowerCase());
  });
});

describe("pointing a verifier at the chain", () => {
  it("links each payment to the right explorer", () => {
    const one = attestation();
    expect(explorerUrl(one.payments[0]!)).toBe("https://bscscan.com/tx/0xabc123");
    expect(explorerUrl(one.payments[1]!)).toBe("https://basescan.org/tx/0xdef456");
  });

  it("says plainly when nothing was actually bought", () => {
    const free = attestation({ payments: [], spent: fp.parse("0.00") });
    const checks = checkOffline({ attestation: free, signature: "0x" }, null);
    const payment = checks.find((check) => check.name === "evidence was paid for");
    // Not a failure: an attestation over free sources is a legitimate thing to
    // hold. It just proves less, and must say which.
    expect(payment?.status).toBe("info");
    expect(payment?.detail).toContain("free sources only");
  });
});
