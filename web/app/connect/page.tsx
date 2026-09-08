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
          data and shows how Telt reasons. For a fuller conversation, connect
          the same agent to ChatGPT or any MCP client.
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
            <strong> “Protect all my SOL at 2x.”</strong>
          </p>
          <p className="notice">
            Anonymous MCP access is read-only. Account protection runs through
            your local Telt process and your own Binance Agent OS session. Never
            paste its token into this website or a chat message.
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
          <p className="eyebrow">WHAT HAPPENS NEXT</p>
          <h3>A conversation with guardrails.</h3>
          <ol>
            <li>Say which Spot holding to protect and how much coverage you want.</li>
            <li>Telt reads the account and checks that the pair trades on both markets.</li>
            <li>Review the Spot holding, target short, margin, leverage, and net exposure.</li>
            <li>Type the one-use code only when those numbers are right.</li>
            <li>Ask how protected you are, or ask Telt to remove the hedge.</li>
          </ol>
          <p>
            Telt keeps reasoning, account access, and execution separate. The
            model can explain a decision; it cannot silently approve or place
            an order.
          </p>
        </section>
      </div>
    </main>
  );
}
