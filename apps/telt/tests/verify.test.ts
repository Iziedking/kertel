import { describe, expect, it } from "vitest";
import { serialize } from "@telt/core/attest";
import * as fp from "@telt/core/money";
import { createSigner } from "@telt/x402";
import { verifyAttestation } from "../src/verify.js";

describe("signature verification does not authenticate signed assertions", () => {
  it("never passes fictional payment, evidence, order or chronology checks", async () => {
    const signer = createSigner(`0x${"a".repeat(64)}`)!;
    const signed = await signer.sign({
      symbol: "ETHUSDT",
      goal: "trade_thesis",
      at: "2000-01-01T00:00:00.000Z",
      agent: signer.address,
      provenance: "0".repeat(64),
      spent: fp.parse("0.01"),
      decision: "BUY_CANDIDATE",
      order: "AUDIT-NONEXISTENT-ORDER",
      payments: [
        {
          provider: "coingecko",
          network: "base-usdc",
          transaction: `0x${"0".repeat(64)}`,
          amount: fp.parse("0.01"),
        },
      ],
    });
    const result = await verifyAttestation(serialize(signed));
    expect(result.ok).toBe(true);
    expect(result.body).toContain("Signature verified");
    expect(result.body).not.toContain("[pass] evidence was paid for");
    expect(result.body).not.toContain("[pass] order");
    expect(result.body).toContain("not independently timestamped");
    expect(result.body).not.toContain(
      "paid\nfor it with its own money before acting",
    );
    const edited = await verifyAttestation(
      serialize(signed).replace("BUY_CANDIDATE", "NO_TRADE"),
    );
    expect(edited.ok).toBe(false);
    expect(edited.body).not.toContain("[pass]");
  });
});

it("binds v2 research and proposal references into the signature", async () => {
  const signer = createSigner(`0x${"a".repeat(64)}`);
  const receipt = await signer.sign({
    symbol: "ETHUSDT",
    goal: "trade",
    at: "2026-09-08T00:00:00Z",
    agent: signer.address,
    provenance: "evidence",
    spent: fp.parse("0"),
    payments: [],
    decision: "BUY",
    order: "fixture-order",
    binding: {
      researchRunId: "run-eth",
      decisionDigest: "decision-eth",
      proposalHash: "proposal-eth",
    },
  });
  const text = serialize(receipt);
  expect(text).toContain("TELT-ATTESTATION-2");
  expect((await verifyAttestation(text)).ok).toBe(true);
  expect(
    (
      await verifyAttestation(
        text.replace(
          "proposalHash=proposal-eth",
          "proposalHash=proposal-other",
        ),
      )
    ).ok,
  ).toBe(false);
});
