import Icon from "../Icon";

export default function Connect() {
  return (
    <main className="wrap">
      <header className="page-head">
        <p className="eyebrow">USE TELT YOUR WAY</p>
        <h1>
          Start with the demo.
          <br />
          Connect when ready<span className="red">.</span>
        </h1>
        <p className="lede">
          The website demo and hosted MCP need no account. Use them to inspect
          Telt from a browser or AI client. Run Telt locally when you want Guard
          Mode to watch your own Binance Agent OS account.
        </p>
      </header>

      <div className="setup-grid">
        <section className="panel">
          <p className="eyebrow">OPTION 1 / NO ACCOUNT</p>
          <h3>Try the live website demo.</h3>
          <p>
            Go back to the homepage, ask about ETH, BTC, BNB, or SOL, and run
            the analysis. Telt fetches a fresh Binance snapshot, asks Claude
            for a constrained verdict, and shows the evidence and risks.
          </p>
          <a className="button primary" href="/#demo">
            Open the live demo <Icon name="arrow" />
          </a>
          <p className="notice">
            This public path cannot see an account, buy paid research, or place
            an order.
          </p>
        </section>

        <section className="panel">
          <p className="eyebrow">OPTION 2 / PUBLIC MCP</p>
          <h3>Inspect Telt from ChatGPT.</h3>
          <p>
            Add this URL as a remote MCP server in ChatGPT or your preferred AI
            client:
          </p>
          <pre className="code">https://mcp.telt.site/mcp</pre>
          <ol>
            <li>Copy the endpoint above.</li>
            <li>Choose “Add remote MCP server” in your AI client.</li>
            <li>Paste the endpoint, then start chatting with Telt.</li>
          </ol>
          <p>
            Ask <strong>“What can Telt do?”</strong>, scan public Binance
            markets, or verify a Telt receipt. These checks need no account and
            carry no trading authority.
          </p>
          <p className="notice">
            The hosted Telt endpoint does not open Binance authorization or
            create an Agentic sub-account. Binance&apos;s official MCP handles
            that login flow. Telt&apos;s full Guard Mode currently runs through a
            local process so its monitor can stay active.
          </p>
        </section>

        <section className="panel full-width">
          <p className="eyebrow">OPTION 3 / FULL GUARD MODE</p>
          <h3>Run the account monitor locally.</h3>
          <p>
            The local runtime uses your own Agent OS session, keeps the
            30-second monitor alive, and stores your mandates and Memory Lane
            on your machine.
          </p>
          <pre className="code">{`npm ci
npm run check
npm run prove
npm run typecheck
node apps/telt/dist/serve.js`}</pre>
          <p>
            In your MCP client, choose a local command server and point it at
            the absolute path to <code>apps/telt/dist/mcp.js</code>. Start in
            fixture mode while learning the workflow. Account access is
            configured in your local environment, never in a browser form.
          </p>
          <p>
            Then ask:
            <strong> “Guard my SOL at 100% coverage and 2x for 24 hours.”</strong>
            Telt will show the mandate boundary and request approval before it
            starts watching the position.
          </p>
        </section>

        <section className="panel full-width">
          <p className="eyebrow">THE GUARD MODE LOOP</p>
          <h3>Approve once, then inspect every change.</h3>
          <ol>
            <li>State the pair, coverage, leverage, and how long the mandate should last.</li>
            <li>Review the notional ceiling and approve Guard Mode once.</li>
            <li>Telt reads Spot and Futures together and classifies the current coverage.</li>
            <li>The daemon adjusts an isolated short only when the position leaves its tolerance band.</li>
            <li>Each fill is checked against the expected Futures position before progress is recorded.</li>
            <li>Ask “show my SOL Memory Lane” to inspect the decisions and exchange references.</li>
            <li>Say “revoke SOL Guard Mode” to stop future adjustments. The existing hedge stays untouched.</li>
          </ol>
          <p>
            Paid research is optional. It explains market context and records
            its cost, while the deterministic Guard controller decides whether
            the hedge needs an adjustment.
          </p>
          <p className="notice">
            The current controller polls every 30 seconds. Guard portfolio caps
            cover active Guard symbols. Account-wide realised loss, event
            streams, notifications, and automatic recovery of interrupted
            orders remain roadmap work.
          </p>
        </section>
      </div>
    </main>
  );
}
