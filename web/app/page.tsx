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
            Every trade
            <br />
            needs a{" "}
            <span className="tell">
              tell<span className="red">.</span>
              <svg viewBox="0 0 240 18" aria-hidden="true">
                <path d="M3 12 Q120 0 237 10" />
              </svg>
            </span>
          </h1>
          <p className="lede">
            Meet Telt. Your Binance AI agent that researches with a budget,
            records its reasoning, and brings you a decision you can inspect.
          </p>
          <div className="actions">
            <Link href="#demo" className="button primary">
              See Telt think <Icon name="arrow" />
            </Link>
            <Link href="/connect" className="button secondary">
              Connect Telt
            </Link>
          </div>
          <p className="micro">
            Research first. Your approval before an order.
          </p>
        </div>
        <div
          className="hero-art"
          aria-label="Telt workflow: observe, research, decide, approve"
        >
          <div className="orbit-label">THE TELL, EXPLAINED</div>
          <div className="signal-card signal-one">
            <span className="mono">01 / OBSERVE</span>
            <strong>Something moved.</strong>
            <span className="spark" aria-hidden="true">
              ▁▂▂▅▃▅▇▆█
            </span>
          </div>
          <div className="signal-card signal-two">
            <span className="mono">02 / INVESTIGATE</span>
            <strong>Is it worth a closer look?</strong>
            <div className="mini-tags">
              <span>Venue price</span>
              <span>Independent data</span>
            </div>
          </div>
          <div className="signal-card signal-three">
            <span className="mono">03 / DECIDE</span>
            <strong>
              A reason.
              <br />A limit. A receipt.
            </strong>
            <span className="round-arrow" aria-hidden="true"><Icon name="arrow" /></span>
          </div>
          <div className="art-caption">
            A workflow you can question at every step.
          </div>
        </div>
      </div>
      <div className="feature-strip">
        <div className="wrap">
          <span>
            <b>Binance Agent OS</b> · execution
          </span>
          <span>
            <b>x402</b> · paid research
          </span>
          <span>
            <b>MCP</b> · your AI client
          </span>
          <span>
            <b>Signed receipts</b> · inspectable claims
          </span>
        </div>
      </div>
      <section className="wrap section" id="demo">
        <div className="section-top">
          <div>
            <p className="eyebrow">TAKE THE CONTROLS</p>
            <h2>
              Watch the decision
              <br />
              take shape.
            </h2>
          </div>
          <p className="section-intro">
            Choose a research question. Inspect what Telt reads, what it skips,
            and where the evidence stops.
          </p>
        </div>
        <Demo />
      </section>
      <section className="wrap section" id="workflow">
        <div className="section-top">
          <div>
            <p className="eyebrow">LESS GUESSWORK. MORE CONTEXT.</p>
            <h2>Curiosity, with limits.</h2>
          </div>
          <p className="section-intro">
            The model reasons. Telt checks the budget, exchange rules, and exact
            order you approve.
          </p>
        </div>
        <div className="three-grid">
          <article className="feature-card mint">
            <span className="card-index">01 / SPEND WITH INTENT</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="orbit" />
            </div>
            <h3>Buy the next useful fact.</h3>
            <p>
              A quick price check starts with the venue and an independent
              quote. A trade question can add flow data. Every source has a
              reason and a cost.
            </p>
          </article>
          <article className="feature-card lavender">
            <span className="card-index">02 / MAKE THE REASON EXPLICIT</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="waves" />
            </div>
            <h3>Leave a decision trail.</h3>
            <p>
              Record a conclusion, cite its evidence, and say what would change
              your mind. Bind that research run to the proposal you review.
            </p>
          </article>
          <article className="feature-card sand">
            <span className="card-index">03 / KEEP YOUR SAY</span>
            <div className="feature-icon" aria-hidden="true">
              <Icon name="arrow" />
            </div>
            <h3>Approve the exact order.</h3>
            <p>
              Review size, fees, and price tolerance. Confirmation is single
              use; expired evidence and changed conditions require a fresh
              proposal.
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
          Bring Telt to your
          <br />
          next conversation<span className="red">.</span>
        </h2>
        <p className="lede">
          Use Telt through an MCP client, with Binance Agent OS connected on
          your own runtime.
        </p>
        <Link href="/connect" className="button primary">
          Set up Telt <Icon name="arrow" />
        </Link>
      </section>
    </main>
  );
}
