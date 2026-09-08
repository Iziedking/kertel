/**
 * The landing page.
 *
 * One job: make a reader understand, in the time they will actually give it,
 * that this agent's reasoning can be checked by someone who does not trust it.
 * So the proof is not described three sections down — a real attestation from a
 * real run is on the screen immediately, with a live Basescan link under it and
 * a verifier one click away.
 */

const ATTESTATION = `TELT-ATTESTATION-1
symbol=ETHUSDT
goal=price_check
at=2026-09-08T02:52:01.134Z
agent=0xd2f6393c6a916acb98057a5920952084b838cfd1
provenance=8c07355f4d640a4f7654116add00fa63b89e2597fa41d958906870ee36436442
spent=0.01
decision=EVIDENCE_ONLY
order=none
payment=coingecko:base-usdc:0x8f6d21822954bc2d9606a6e4a7f9c9464e62647f1c73bfb2059b3a72b486b873:0.01
sig=0x9941c368ddddfc8621fadb557b384d7913ac715c91c4049f11012c5795f8badf0139eb...`;

const TX = "0x8f6d21822954bc2d9606a6e4a7f9c9464e62647f1c73bfb2059b3a72b486b873";

export default function Home() {
  return (
    <main>
      <div className="wrap">
        <header className="hero">
          <p className="eyebrow">Binance Agent OS · x402 · MCP</p>
          <h1 className="display">
            A trading agent you can <span className="accent">verify</span>.
          </h1>
          <p className="lede">
            Telt buys its own research with real money and signs every conclusion with the same key
            that paid for it. The payment is a transaction on a public chain. The evidence is
            committed to by hash. Anyone can check that chain — no account, no credentials, nothing
            installed.
          </p>
          <p className="lede">
            Every AI trading agent is asked the same question, and none of them can answer it:{" "}
            <em>how do I know it did not invent the thesis?</em> Logs do not answer it. A log is
            written by the same program that would have lied, kept by the same operator who benefits
            from the lie, and editable afterwards by either.
          </p>
          <div className="row">
            <a className="button" href="/verify">
              Verify a proof
            </a>
            <a className="button ghost" href="#connect">
              Connect your client
            </a>
          </div>
        </header>

        <section id="proof">
          <h2>This is a real one</h2>
          <p className="lede">
            From an actual run. The cent it spent is on Base, and the signature is by the address
            that spent it.
          </p>
          <pre className="proof">{ATTESTATION}</pre>
          <div className="row">
            <a className="pill" href={`https://basescan.org/tx/${TX}`} target="_blank" rel="noreferrer">
              See the payment on Basescan ↗
            </a>
            <a className="pill" href="/verify">
              Check the signature yourself ↗
            </a>
          </div>

          <div className="grid" style={{ marginTop: 30 }}>
            <div className="card">
              <h3>The payment is on a public chain</h3>
              <p className="dim">
                Telt buys research over x402, so every source it read left a transaction with an
                amount, a payer and a block time. Research that never happened has no transaction.
              </p>
            </div>
            <div className="card">
              <h3>The evidence is committed to</h3>
              <p className="dim">
                The digest covers what each source actually returned, so a payload cannot be swapped
                afterwards for one that better fits the outcome.
              </p>
            </div>
            <div className="card">
              <h3>The signer is the payer</h3>
              <p className="dim">
                The account that sent those transactions signs the conclusion. Not “an agent”
                concluded this — the one whose money moved.
              </p>
            </div>
            <div className="card">
              <h3>A block time cannot be backdated</h3>
              <p className="dim">
                The chain records when the money moved and the exchange records when the order was
                placed. A thesis written after a trade cannot be made to look like one written
                before it.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2>What it does between proofs</h2>
          <table>
            <thead>
              <tr>
                <th>Ask it</th>
                <th>What happens</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">what&apos;s moving?</td>
                <td>
                  Reads all 3,695 pairs in one free call and ranks them above a liquidity floor, so a
                  pair printing +400% on twelve thousand dollars never reaches you.
                </td>
              </tr>
              <tr>
                <td className="mono">what do you think of ETH?</td>
                <td>
                  Buys a price for a cent, a tiebreak for another if two sources disagree, and Smart
                  Money flows only when the question is whether to trade. Then signs the result.
                </td>
              </tr>
              <tr>
                <td className="mono">long it at 3x</td>
                <td>
                  Sets isolated margin and a leverage ceiling before it will issue a code — Binance
                  ships ETHUSDT at 20x on cross — and shows the liquidation price before you agree.
                </td>
              </tr>
              <tr>
                <td className="mono">take half at +30%, stop at −10%</td>
                <td>
                  From the moment you approve it, nobody types anything again. It trims into
                  strength, ratchets the stop as a winner runs, and closes reduce-only.
                </td>
              </tr>
              <tr>
                <td className="mono">how am I doing?</td>
                <td>
                  Flags anything unprotected first. A leveraged position with no exit plan is the
                  loudest line, because it is the only kind the exchange can close for you.
                </td>
              </tr>
            </tbody>
          </table>
          <p className="dim" style={{ marginTop: 18 }}>
            Two things always stop and ask: spending money on research, and a confirmation code
            before any order. Those are not friction to remove — they are why it can be trusted with
            real funds.
          </p>
        </section>

        <section id="connect">
          <h2>Point any client at it</h2>
          <p className="lede">
            Telt is an MCP server. Claude, Claude Code, Codex, ChatGPT and VS Code all speak it.
          </p>
          <div className="grid">
            <div>
              <h3>Claude Code</h3>
              <pre className="snippet">claude mcp add telt \
  --transport http \
  https://mcp.telt.site/mcp</pre>
            </div>
            <div>
              <h3>Codex</h3>
              <pre className="snippet">{`[mcp_servers.telt]
url = "https://mcp.telt.site/mcp"`}</pre>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 26 }}>
            <h3 style={{ color: "var(--cream)" }}>What a stranger is allowed to do</h3>
            <p className="dim">
              <strong>Anyone, no credentials:</strong> verify proofs and read markets. Verification
              has to work for the person who doubts it — making them install the thing that produced
              the proof would defeat the point.
            </p>
            <p className="dim">
              <strong>With your own Agent OS token:</strong> the full agent against your own
              account. The token is never written to disk, and each caller gets a separate database
              named by a hash of it rather than by it.
            </p>
            <p className="dim">
              <strong>Nobody gets the operator&apos;s wallet.</strong> Paid research spends real
              money, so an anonymous caller who could spend it would drain it. Callers get every
              capability except that one, and are told why.
            </p>
          </div>
        </section>

        <section>
          <h2>What it will not do</h2>
          <div className="grid">
            <div className="card">
              <h3>Guess an identifier</h3>
              <p className="dim">
                A ticker is ambiguous on every data provider. With no verified id, Telt refuses that
                source by name rather than pricing the wrong asset.
              </p>
            </div>
            <div className="card">
              <h3>Turn a chat message into an order</h3>
              <p className="dim">
                No code path takes a model output and makes it a URL, a size, or a symbol. A prompt
                injection reaches tools that prepare a proposal you then decline.
              </p>
            </div>
            <div className="card">
              <h3>Call an unresolved order a failure</h3>
              <p className="dim">
                A timeout is <span className="mono">EXECUTION_RESULT_UNKNOWN</span>. Telt stops
                itself and reconciles using the client order id it chose before sending.
              </p>
            </div>
            <div className="card">
              <h3>Claim it checked something it did not</h3>
              <p className="dim">
                The verifier settles the signature with arithmetic and hands you explorer links for
                the payments. Asserting those without a request would be the self-attestation this
                whole thing replaces.
              </p>
            </div>
          </div>
        </section>
      </div>

      <footer>
        <div className="wrap">
          <p>
            Telt · Binance Agent OS, x402, MCP ·{" "}
            <a href="https://github.com/Iziedking/kertel">source</a>
          </p>
          <p className="mono" style={{ fontSize: 12 }}>
            A well-evidenced trade can still lose. Proof is about the reasoning, not the outcome.
          </p>
        </div>
      </footer>
    </main>
  );
}
