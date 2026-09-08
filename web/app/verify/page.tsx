"use client";

/**
 * The verifier.
 *
 * It calls the public MCP endpoint — the same one anybody can point their own
 * client at — rather than a private route with special access to the truth.
 * That is deliberate: a verifier the site alone can run is just another thing
 * to take on trust, and the whole point here is that nobody has to.
 *
 * It also refuses to overstate what it did. The signature is settled here. The
 * payments are facts about a blockchain, so they come back as links, and the
 * reader is told plainly that following them is their job.
 */

import { useState } from "react";

const ENDPOINT =
  process.env.NEXT_PUBLIC_TELT_MCP ?? "https://mcp.telt.site/mcp";

const EXAMPLE = `TELT-ATTESTATION-1
symbol=ETHUSDT
goal=price_check
at=2026-09-08T02:52:01.134Z
agent=0xd2f6393c6a916acb98057a5920952084b838cfd1
provenance=8c07355f4d640a4f7654116add00fa63b89e2597fa41d958906870ee36436442
spent=0.01
decision=EVIDENCE_ONLY
order=none
payment=coingecko:base-usdc:0x8f6d21822954bc2d9606a6e4a7f9c9464e62647f1c73bfb2059b3a72b486b873:0.01
sig=0x9941c368ddddfc8621fadb557b384d7913ac715c91c4049f11012c5795f8badf0139eb657e6d48a50c578d882484a30d75853d97ac0a682204d9b648b74577de1b`;

/** One JSON-RPC call over streamable HTTP, which answers as SSE. */
async function callTool(name: string, args: unknown): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (!response.ok) {
    throw new Error(`The endpoint answered ${String(response.status)}.`);
  }

  const text = await response.text();
  for (const line of text.split("\n")) {
    const payload = line.startsWith("data: ") ? line.slice(6) : line;
    if (payload.trim() === "" || payload.startsWith("event:")) continue;
    try {
      const message = JSON.parse(payload) as {
        result?: { content?: { text?: string }[] };
        error?: { message?: string };
      };
      if (message.error !== undefined) {
        throw new Error(message.error.message ?? "The endpoint refused that.");
      }
      if (message.result?.content !== undefined) {
        return message.result.content.map((part) => part.text ?? "").join("\n");
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message !== "Unexpected end of JSON input") {
        // A real error from the server, not a partial SSE frame.
        if (!cause.message.startsWith("Unexpected token")) throw cause;
      }
    }
  }
  throw new Error("The endpoint answered in a shape this page does not recognise.");
}

export default function Verify() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const body = await callTool("telt_verify", { attestation: text });
      setResult(body);
      setFailed(!body.startsWith("Attestation verified"));
    } catch (cause) {
      setResult(
        [
          "This page could not reach the Telt endpoint.",
          "",
          cause instanceof Error ? cause.message : "Unknown problem.",
          "",
          "That says nothing about whether the attestation is real. You can check it",
          "from your own machine instead:",
          "",
          "  claude mcp add telt --transport http " + ENDPOINT,
          "  then ask: verify this attestation",
        ].join("\n"),
      );
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="wrap">
        <header className="hero" style={{ paddingBottom: 28 }}>
          <p className="eyebrow">Proof of research</p>
          <h1 className="display" style={{ fontSize: "clamp(32px, 4.6vw, 50px)" }}>
            Check it yourself.
          </h1>
          <p className="lede">
            Paste an attestation. This recovers who signed it, confirms that address matches the one
            it claims paid for the evidence, and gives you the blockchain links so you can check the
            payments with your own eyes.
          </p>
          <p className="lede">
            It runs through the public MCP endpoint — the same one you can point your own client at.
            Nothing here has a private path to the truth.
          </p>
        </header>

        <section style={{ borderTop: "none", paddingTop: 0 }}>
          <textarea
            className="field"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"TELT-ATTESTATION-1\nsymbol=…\n…\nsig=0x…"}
            spellCheck={false}
          />
          <div className="row">
            <button className="button" onClick={() => void run()} disabled={busy || text.trim() === ""}>
              {busy ? "Checking…" : "Verify"}
            </button>
            <button className="button ghost" onClick={() => setText(EXAMPLE)} disabled={busy}>
              Use a real example
            </button>
            <button
              className="button ghost"
              onClick={() => setText(EXAMPLE.replace("EVIDENCE_ONLY", "BUY_CANDIDATE"))}
              disabled={busy}
            >
              Try a forged one
            </button>
          </div>

          {result !== null && (
            <pre className={`result ${failed ? "fail" : "pass"}`}>{result}</pre>
          )}

          <div className="panel" style={{ marginTop: 30 }}>
            <h3 style={{ color: "var(--cream)" }}>What a pass means, and what it does not</h3>
            <p className="dim">
              A verified attestation proves this agent held this conclusion over this evidence, and
              paid for that evidence with its own money before acting. The signature is settled here
              with arithmetic; there is nothing to take on faith.
            </p>
            <p className="dim">
              It does not prove the conclusion was right. A well-evidenced trade can still lose, and
              an agent that pays for good data can still read it badly. Proof is about the reasoning,
              not the outcome.
            </p>
            <p className="dim">
              It also does not confirm the payments — those are facts about a blockchain, and this
              page has not queried it. Follow the explorer links, check the sender matches the agent,
              the amount matches, and the block time sits before any order claimed.
            </p>
          </div>
        </section>
      </div>

      <footer>
        <div className="wrap">
          <p>
            <a href="/">← Telt</a>
          </p>
        </div>
      </footer>
    </main>
  );
}
