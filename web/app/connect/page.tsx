import Icon from "../Icon";

export default function Connect() {
  return (
    <main className="wrap">
      <header className="page-head">
        <p className="eyebrow">BRING YOUR OWN CLIENT</p>
        <h1>
          Your agent.
          <br />
          Now with Telt<span className="red">.</span>
        </h1>
        <p className="lede">
          Telt runs as an MCP server. Your AI client reasons with its tools;
          Binance Agent OS provides the account and execution connection.
        </p>
      </header>
      <div className="setup-grid">
        <section className="panel">
          <p className="eyebrow">01 / GET THE RUNTIME</p>
          <h3>Start with a rehearsal.</h3>
          <p>
            Use Node.js 22.13 or later. From a local copy of the repository:
          </p>
          <pre className="code">{`npm ci
npm run check
npm run prove

# Start the MCP server in fixture mode
node apps/telt/dist/mcp.js`}</pre>
          <p>
            The default fixture mode does not place live orders. Paid research
            also needs explicit wallet configuration. The public website demo
            uses live Binance market data and a server-side model with no order access.
          </p>
          <a className="inline-link" href="https://github.com/Iziedking/kertel">
            Open source and setup instructions <Icon name="arrow" />
          </a>
        </section>
        <section className="panel">
          <p className="eyebrow">02 / CONNECT YOUR CLIENT</p>
          <h3>Give your AI the tools.</h3>
          <p>
            Add the local server in your MCP client. Replace the path with your
            checkout’s absolute path.
          </p>
          <pre className="code">
            {JSON.stringify(
              {
                mcpServers: {
                  telt: {
                    command: "node",
                    args: ["/absolute/path/to/kertel/apps/telt/dist/mcp.js"],
                    env: {
                      TELT_MODE: "fixture",
                      TELT_OWNER_WHATSAPP: "+12025550123",
                    },
                  },
                },
              },
              null,
              2,
            )}
          </pre>
          <p>
            For account access, configure <code>TELT_BINANCE_MCP_TOKEN</code>{" "}
            from Binance Agent OS in your local runtime environment, and replace
            the sample owner number with your own. Never paste credentials into
            this website or a public conversation.
          </p>
        </section>
        <section className="panel full-width">
          <p className="eyebrow">03 / TRY A COMPLETE CONVERSATION</p>
          <h3>“Research ETH, then show your reasoning.”</h3>
          <ol>
            <li>
              Ask for a price check or a trade investigation. Inspect the
              research receipt and run ID.
            </li>
            <li>
              Ask the model to record a decision with <code>telt_decide</code>,
              citing evidence and invalidation conditions.
            </li>
            <li>
              If you want an order, request a proposal tied to that decision.
              Review its size, fees and current limitations.
            </li>
            <li>
              Only confirm an exact order you intend to place. Live mode and the
              execution flag must both be enabled on your runtime.
            </li>
          </ol>
          <p>
            Account-wide loss and exposure accounting are currently unavailable.
            Discretionary live entries are paused. Explicit orders retain
            per-order and available-balance checks. Stops require a running
            daemon and cannot guarantee an exit price.
          </p>
        </section>
      </div>
    </main>
  );
}
