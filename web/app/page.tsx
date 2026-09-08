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
            Telt reads your Binance Spot holding, calculates a matching isolated
            Futures hedge, and waits for your approval before it acts.
          </p>
          <div className="actions">
            <Link href="#demo" className="button primary">
              Try the public agent <Icon name="arrow" />
            </Link>
            <Link href="/connect" className="button secondary">
              Connect via MCP
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
          <div className="orbit-label">PROTECTION, EXPLAINED</div>
          <div className="signal-card signal-one">
            <span className="mono">01 / READ</span>
            <strong>Your real Spot holding.</strong>
            <span className="spark" aria-hidden="true">
              ▁▂▂▅▃▅▇▆█
            </span>
          </div>
          <div className="signal-card signal-two">
            <span className="mono">02 / MATCH</span>
            <strong>Size the Futures short.</strong>
            <div className="mini-tags">
              <span>Spot balance</span>
              <span>Exchange limits</span>
            </div>
          </div>
          <div className="signal-card signal-three">
            <span className="mono">03 / APPROVE</span>
            <strong>
              Both legs.
              <br />One clear code.
            </strong>
            <span className="round-arrow" aria-hidden="true"><Icon name="arrow" /></span>
          </div>
          <div className="art-caption">
            Ask later: “How protected am I?”
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
            <b>Isolated Futures</b> · one-symbol hedge
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
            <p className="eyebrow">ONE REQUEST. BOTH SIDES.</p>
            <h2>A hedge you can understand.</h2>
          </div>
          <p className="section-intro">
            Say what you want protected. Telt turns that intent into a bounded,
            reviewable action on Binance.
          </p>
        </div>
        <div className="three-grid">
          <article className="feature-card mint">
            <span className="card-index">01 / READ THE EXPOSURE</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="orbit" />
            </div>
            <h3>Start from what you hold.</h3>
            <p>
              Telt reads the actual Spot balance, including locked assets, and
              confirms that a matching USD-M Futures market exists.
            </p>
          </article>
          <article className="feature-card lavender">
            <span className="card-index">02 / CALCULATE THE HEDGE</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="waves" />
            </div>
            <h3>See the protection before it exists.</h3>
            <p>
              Review coverage, short quantity, position value, isolated
              leverage, required margin, available Futures cash, and limits.
            </p>
          </article>
          <article className="feature-card sand">
            <span className="card-index">03 / WATCH AND REMEMBER</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="arrow" />
            </div>
            <h3>Keep the whole position in view.</h3>
            <p>
              After your one-use confirmation, Protection Watch checks both
              legs for free. Ask for paid context only when you need it. Memory
              Lane records the story through the reduce-only close.
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
