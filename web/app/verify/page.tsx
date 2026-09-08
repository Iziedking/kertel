"use client";
import { useState } from "react";
import { recoverMessageAddress } from "viem";
import { canonicalize, deserialize, explorerUrl } from "../../lib/attestation";
import { EXAMPLE } from "../../lib/example";
type Result = {
  valid: boolean;
  signer: string;
  claimed: string;
  decision: string;
  at: string;
  provenance: string;
  order: string | null;
  binding: string;
  links: { provider: string; url: string }[];
};
export default function Verify() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  function change(value: string) {
    setText(value);
    setResult(null);
    setError(null);
  }
  async function run() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const signed = deserialize(text);
      if (!signed)
        throw new Error(
          "This receipt is incomplete or has repeated fields. Paste one full attestation block.",
        );
      const signer = await recoverMessageAddress({
        message: canonicalize(signed.attestation),
        signature: signed.signature as `0x${string}`,
      });
      const a = signed.attestation;
      setResult({
        valid: signer.toLowerCase() === a.agent.toLowerCase(),
        signer,
        claimed: a.agent,
        decision: a.decision,
        at: a.at,
        provenance: a.provenance,
        order: a.order,
        binding: a.binding
          ? JSON.stringify(a.binding)
          : "No v2 linkage in this receipt",
        links: a.payments.flatMap((p) => {
          const url = explorerUrl(p);
          return url ? [{ provider: p.provider, url }] : [];
        }),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The receipt could not be verified.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wrap">
      <header className="page-head">
        <p className="eyebrow">INDEPENDENT SIGNATURE CHECK</p>
        <h1>
          Don’t take its word.
          <br />
          Check the receipt<span className="red">.</span>
        </h1>
        <p className="lede">
          Paste a signed Telt receipt. Verification runs locally in your browser
          using the shared open-source verifier and signature recovery. No Telt
          server, wallet connection, or account is needed.
        </p>
      </header>
      <div className="verify-grid">
        <section className="panel">
          <label className="field-label" htmlFor="attestation">
            Signed attestation
          </label>
          <textarea
            id="attestation"
            className="field"
            value={text}
            maxLength={64000}
            onChange={(e) => change(e.target.value)}
            spellCheck={false}
            placeholder={"TELT-ATTESTATION-1\nsymbol=ETHUSDT\n…\nsig=0x…"}
          />
          <div className="actions">
            <button
              className="button primary"
              disabled={busy || !text.trim()}
              onClick={() => void run()}
            >
              {busy ? "Checking…" : "Verify signature ↗"}
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => change(EXAMPLE)}
            >
              Load sample
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                change(EXAMPLE.replace("EVIDENCE_ONLY", "BUY_CANDIDATE"))
              }
            >
              Tamper with sample
            </button>
          </div>
          <p className="micro">
            Sample: a recorded research receipt from September 8. Loading it
            makes no payment.
          </p>
        </section>
        <section className="panel" aria-live="polite">
          <p className="eyebrow">WHAT WAS CHECKED</p>
          <h3>
            {result
              ? result.valid
                ? "Signature verified."
                : "Signature mismatch."
              : error
                ? "Could not verify."
                : "Evidence has layers."}
          </h3>
          {error && (
            <p className="fail-label" role="alert">
              {error}
            </p>
          )}
          {!result && !error && (
            <p className="empty-state">
              Load the sample and verify it. Then change the conclusion and run
              the check again to see the signature fail.
            </p>
          )}
          <div className="result-check">
            <strong>
              Signature integrity{" "}
              <span
                className={
                  result ? (result.valid ? "pass-label" : "fail-label") : ""
                }
              >
                {result ? (result.valid ? "PASS" : "FAIL") : "NOT CHECKED"}
              </span>
            </strong>
            <p>
              {result
                ? result.valid
                  ? "The recovered signer matches the address stated in this receipt. This does not identify a person or authenticate its claims."
                  : "The displayed claims do not recover the stated signer. Treat this receipt as invalid."
                : "Checks the signature against the receipt’s stated address."}
            </p>
          </div>
          {[
            "Payment settlement",
            "Provider data and origin",
            "Order and execution",
            "Independent decision timestamp",
          ].map((label) => (
            <div className="result-check" key={label}>
              <strong>
                {label}
                <span>NOT VERIFIED</span>
              </strong>
              <p>
                {label === "Payment settlement"
                  ? "A transaction reference is a claim. Check the receipt’s token-transfer payer, merchant, asset, amount, and success on the appropriate chain."
                  : label === "Provider data and origin"
                    ? "A signed digest does not establish that a provider returned accurate or authentic data."
                    : label === "Order and execution"
                      ? "An exchange order reference requires independent account records."
                      : "A claimed time is signed text. A payment block time does not timestamp this off-chain decision."}
              </p>
            </div>
          ))}
          {result && (
            <>
              <details className="result-check">
                <summary>Inspect recovered fields</summary>
                <div className="audit-detail">
                  Signer: {result.signer}
                  <br />
                  Claimed: {result.claimed}
                  <br />
                  Decision: {result.decision}
                  <br />
                  Claimed time: {result.at}
                  <br />
                  Evidence digest: {result.provenance}
                  <br />
                  Claimed order: {result.order ?? "none"}
                  <br />
                  Signed linkage: {result.binding}
                </div>
              </details>
              {result.links.length > 0 && (
                <div className="result-check">
                  <strong>Claimed payment references</strong>
                  {result.links.map((link, i) => (
                    <p key={i}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Inspect {link.provider} transaction ↗
                      </a>
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
