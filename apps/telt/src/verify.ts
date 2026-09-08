/**
 * Checking somebody else's proof.
 *
 * This is the half that makes the other half worth anything. A receipt only an
 * agent can produce is marketing; a receipt anyone can check is evidence. So
 * this path deliberately does not care where the attestation came from: it
 * verifies Telt's own proofs and a stranger's identically, reads nothing from
 * the local database, and reaches a verdict from the text alone.
 *
 * It is also written to be unhelpful in one specific way. It will not say
 * "verified" about anything it did not actually check. The signature it can
 * settle here, with arithmetic. The payments it cannot — those are facts about
 * a blockchain, and asserting them without making a request would be exactly
 * the self-attestation this whole feature exists to replace. So it hands back
 * explorer links and says plainly that following them is the reader's job.
 */

import { checkOffline, deserialize, explorerUrl } from "@telt/core/attest";
import * as fp from "@telt/core/money";
import { recoverSigner } from "@telt/x402";

export type VerifyResult = {
  readonly ok: boolean;
  readonly body: string;
};

export async function verifyAttestation(text: string): Promise<VerifyResult> {
  const signed = deserialize(text);
  if (signed === null) {
    return {
      ok: false,
      body: [
        "That is not a Telt attestation.",
        "",
        "An attestation begins with a TELT-ATTESTATION-1 line and ends with a sig= line.",
        "Paste the whole block, including both. Anything missing in between and Telt",
        "will not guess at it, because a half-read proof is worse than none.",
      ].join("\n"),
    };
  }

  const recovered = await recoverSigner(signed);
  const checks = checkOffline(signed, recovered);
  const signatureValid = checks.find((check) => check.name === "signature")?.status === "pass";

  const lines: string[] = [];
  lines.push(signatureValid ? "Signature verified" : "ATTESTATION FAILED");
  lines.push("");
  lines.push(`  Symbol:     ${signed.attestation.symbol}`);
  lines.push(`  Concluded:  ${signed.attestation.decision}`);
  lines.push(`  At:         ${signed.attestation.at}`);
  lines.push(`  Agent:      ${signed.attestation.agent.toLowerCase()}`);
  lines.push(`  Evidence:   ${signed.attestation.provenance}`);
  lines.push("");

  for (const check of checks) {
    const label = check.status === "pass" ? "pass" : check.status === "fail" ? "FAIL" : "note";
    lines.push(`  [${label}] ${check.name}`);
    lines.push(`         ${check.detail}`);
  }

  const paid = signed.attestation.payments.filter((payment) => payment.transaction !== null);
  if (paid.length > 0) {
    lines.push("");
    lines.push("  Check these yourself. Telt has not followed them for you:");
    for (const payment of paid) {
      const url = explorerUrl(payment);
      lines.push(
        `    ${payment.provider} ${fp.format(payment.amount)} USDC on ${payment.network}`,
      );
      lines.push(`      ${url ?? payment.transaction ?? ""}`);
    }
    lines.push("");
    lines.push(
      `  On each one, confirm the token-transfer payer is ${signed.attestation.agent.toLowerCase()}, that the`,
    );
    lines.push("  token, merchant and amount match. A payment time does not timestamp this decision.");
  }

  lines.push("");
  if (signatureValid) {
    lines.push("This verifies the signature over the displayed claims. It does not verify payment,");
    lines.push("provider data, agent identity, the order, or that the decision preceded a trade.");
  } else {
    lines.push(
      "Do not act on this. The signature does not match the agent it names, which means",
    );
    lines.push("the document was altered after signing or was never signed by that agent.");
  }

  return { ok: signatureValid, body: lines.join("\n") };
}
