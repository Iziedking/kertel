import Link from "next/link";
import Demo from "./Demo";
import Icon from "./Icon";
export default function Home() {
  return (
    <main>
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" /> BUILT WITH BINANCE AGENT OS
          </p>
          <h1>
            Tell Telt what
            <br />
            to{" "}
            <span className="tell">
              protect<span className="red">.</span>
              <svg viewBox="0 0 240 18" aria-hidden="true">
                <path d="M3 12 Q120 0 237 10" />
              </svg>
            </span>
          </h1>
          <p className="lede">
            Approve one bounded mandate. Telt watches the Spot holding, keeps an
            isolated Futures hedge inside your limits, records each adjustment,
            and stops when it cannot prove the account state.
          </p>
          <div className="actions">
            <Link href="#demo" className="button primary">
              Try the public agent <Icon name="arrow" />
            </Link>
            <Link href="/connect" className="button secondary">
              Run Guard Mode
            </Link>
          </div>
          <p className="micro">
            Any USDT pair listed on both Spot and USD-M Futures.
          </p>
        </div>
        <div
          className="hero-art"
          aria-label="Telt workflow: read a holding, calculate protection, approve"
        >
          <div className="orbit-label">GUARD MODE / ONE APPROVAL</div>
          <div className="signal-card signal-one">
            <span className="mono">01 / OBSERVE</span>
            <strong>Read both Binance legs.</strong>
            <span className="spark" aria-hidden="true">
              ▁▂▂▅▃▅▇▆█
            </span>
          </div>
          <div className="signal-card signal-two">
            <span className="mono">02 / PROTECT</span>
            <strong>Keep coverage in range.</strong>
            <div className="mini-tags">
              <span>Mandate limits</span>
              <span>Isolated margin</span>
            </div>
          </div>
          <div className="signal-card signal-three">
            <span className="mono">03 / PROVE</span>
            <strong>
              Verify the fill.
              <br />Record the reason.
            </strong>
            <span className="round-arrow" aria-hidden="true"><Icon name="arrow" /></span>
          </div>
          <div className="art-caption">
            Ask anytime: “What changed?”
          </div>
        </div>
      </div>
      <div className="feature-strip">
        <div className="wrap">
          <span>
            <b>Binance Agent OS</b> · account and execution
          </span>
          <span>
            <b>MCP</b> · plain-language control
          </span>
          <span>
            <b>Guard Mode</b> · bounded position care
          </span>
          <span>
            <b>Memory Lane</b> · every protection event
          </span>
        </div>
      </div>
      <section className="wrap section" id="demo">
        <div className="section-top">
          <div>
            <p className="eyebrow">TAKE THE CONTROLS</p>
            <h2>
              Meet Telt without
              <br />
              connecting an account.
            </h2>
          </div>
          <p className="section-intro">
            Ask a live market question first. The public route shows the same
            bounded reasoning style and has no account or order access.
          </p>
        </div>
        <Demo />
      </section>
      <section className="wrap section" id="workflow">
        <div className="section-top">
          <div>
            <p className="eyebrow">ONE APPROVAL. CONTINUOUS CHECKS.</p>
            <h2>Protection that follows the position.</h2>
          </div>
          <p className="section-intro">
            Spot balances change after a hedge opens. Telt detects the drift and
            adjusts only within the mandate you approved.
          </p>
        </div>
        <div className="three-grid">
          <article className="feature-card mint">
            <span className="card-index">01 / APPROVE THE BOUNDARY</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="orbit" />
            </div>
            <h3>Set the rules once.</h3>
            <p>
              Choose the pair, target coverage, leverage, and expiry. Review
              the operator-set cap, then approve a versioned, revocable mandate.
            </p>
          </article>
          <article className="feature-card lavender">
            <span className="card-index">02 / DETECT THE DRIFT</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="waves" />
            </div>
            <h3>Watch Spot and Futures together.</h3>
            <p>
              Each sweep classifies the position as protected, underhedged,
              overhedged, unprotected, or unknown. Tolerance and cooldown rules
              prevent small repeated orders.
            </p>
          </article>
          <article className="feature-card sand">
            <span className="card-index">03 / ADJUST AND VERIFY</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="arrow" />
            </div>
            <h3>Prove the new state.</h3>
            <p>
              Telt uses Futures lot and notional filters, checks Guard portfolio
              caps, writes the operation before sending it, verifies the fill,
              and stops on an unresolved result. Memory Lane keeps the record.
            </p>
          </article>
        </div>
      </section>
      <section className="wrap section" id="capabilities">
        <div className="section-top">
          <div>
            <p className="eyebrow">CAPABILITY MAP</p>
            <h2>Built now. Roadmap stated plainly.</h2>
          </div>
          <p className="section-intro">
            The account workflow runs through the user&apos;s local Agent OS
            session. The public demo has market access and no trading authority.
          </p>
        </div>
        <div className="three-grid">
          <article className="feature-card mint">
            <span className="card-index">BUILT / GUARD LOOP</span>
            <h3>Maintain a bounded hedge.</h3>
            <p>
              Guard Mode can open, increase, or reduce one matching isolated
              USD-M Futures hedge. Every adjustment needs fresh account reads,
              complete Guard portfolio accounting, and the live execution gate.
            </p>
          </article>
          <article className="feature-card lavender">
            <span className="card-index">BUILT / MEMORY LANE</span>
            <h3>Keep the decision record.</h3>
            <p>
              Telt records proposals, classifications, adjustments, failures,
              paid investigations, and revocation. Research can explain market
              context, but it cannot authorize or block protection.
            </p>
          </article>
          <article className="feature-card sand">
            <span className="card-index">ROADMAP / OPERATIONS</span>
            <h3>Close the remaining gaps.</h3>
            <p>
              WebSocket event intake, full-account risk discovery, automatic
              reconciliation of interrupted orders, and notifications are the
              next operating milestones.
            </p>
          </article>
        </div>
      </section>
      <section className="wrap section">
        <div className="proof-banner">
          <div>
            <p className="eyebrow">TRUST HAS A SCOPE</p>
            <h2>
              A signature you can check.
              <br />
              Claims you can challenge.
            </h2>
            <p>
              Verify a receipt in your own browser. A valid signature
              establishes who signed the displayed claims. Payments, source
              data, timing, and order fills need their own checks.
            </p>
            <Link className="button ink-button" href="/verify">
              Open the verifier <Icon name="arrow" />
            </Link>
          </div>
          <div className="proof-stamp" aria-hidden="true">
            <span>TELT RECEIPT</span>
            <b><Icon name="check" /></b>
            <span>SIGNATURE ≠ TRUTH</span>
          </div>
        </div>
      </section>
      <section className="wrap section connect-banner">
        <p className="eyebrow">YOUR CLIENT. YOUR ACCOUNT.</p>
        <h2>
          Bring Telt to ChatGPT
          <br />
          or any MCP client<span className="red">.</span>
        </h2>
        <p className="lede">
          Connect <code>https://mcp.telt.site/mcp</code>, then say “protect my
          SOL” or “investigate my SOL protection and show its Memory Lane.”
        </p>
        <Link href="/connect" className="button primary">
          See the MCP setup <Icon name="arrow" />
        </Link>
      </section>
    </main>
  );
}
