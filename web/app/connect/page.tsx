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
          The website demo needs no account. It reads public Binance market
          data and shows how Telt reasons. Run the local MCP when you want Guard
          Mode to use your own Binance Agent OS session.
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
          <p className="eyebrow">OPTION 2 / MCP CLIENT</p>
          <h3>Give your AI the Telt endpoint.</h3>
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
            Start by asking: <strong>“What can Telt do?”</strong> With your own
            local account session, try:
            <strong> “Guard my SOL at 100% coverage and 2x for 24 hours.”</strong>
            Telt will explain the boundary and ask for one approval before it
            arms the mandate.
          </p>
          <p className="notice">
            The hosted MCP cannot use your Binance account. Live protection
            runs through your local Telt process and your Binance Agent OS
            session. Keep the token in the local environment.
          </p>
        </section>

        <section className="panel full-width">
          <p className="eyebrow">IF YOU ARE RUNNING TELT LOCALLY</p>
          <h3>Use the local MCP server.</h3>
          <p>
            This is for developers who want the runtime on their own machine.
            It is separate from the one-click remote connection above.
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
