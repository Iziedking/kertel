# Telt

Telt is a conversational Binance protection agent built on Binance Agent OS. Tell it which Spot holding to protect. It reads the real balance, calculates a matching isolated USD-M Futures short, shows the two legs together, and waits for a one-use confirmation code before opening anything.

- [Run the live demo](https://telt.site/#demo)
- [Connect an MCP client](https://telt.site/connect)
- [Verify a receipt](https://telt.site/verify)

## Start here

The public demo requires no account. Ask a market question and Telt will read a live public Binance quote, send bounded evidence through its server-side Claude review, and return:

- the Binance observation time
- a structured verdict
- evidence gaps and research limits
- a clear no-order boundary

The browser receives no provider key, account credential, research wallet, or order capability.

For the full agent workflow, connect ChatGPT or another MCP client to `https://mcp.telt.site/mcp`. The client maps plain requests such as “protect my SOL” and “how protected is my BTC?” to Telt's guarded account tools.

## How it works

1. Say what to protect, for example “protect all my SOL at 2x.”
2. Telt verifies that `SOLUSDT` trades on both Binance Spot and USD-M Futures, then reads the actual SOL balance.
3. It calculates the short quantity from the requested coverage and checks the Futures lot size, minimum position value, Telt's cap, leverage ceiling, and available USDT margin.
4. It shows the Spot holding, target short, resulting net exposure, required margin, and available Futures cash. No account setting or order changes at this point.
5. A human types the one-use code. Telt rechecks the position and price, forces isolated margin, sets the approved leverage, and opens the short.
6. Ask “how protected is my SOL?” to read both legs as one position. Ask “remove my SOL protection” to close the Futures leg with a reduce-only order.

This path is generic. It supports any `...USDT` asset that Binance currently lists on both Spot and USD-M Futures. BTC, ETH, BNB, and SOL are examples, not a hardcoded allowlist. A Spot-only token cannot use this hedge path.

Budgeted research remains available when the user wants market context. It is optional for a direct protection request and does not determine whether a matching hedge can be sized.

An explicitly requested order may omit research. Its receipt records that choice. A pre-send quote check cannot guarantee the fill price of a market order.

## Connect an MCP client

Use the hosted endpoint for a quick demo:

```
https://mcp.telt.site/mcp
```

1. Copy the endpoint.
2. In ChatGPT or another compatible client, choose **Add remote MCP server**.
3. Paste the endpoint and start a conversation.

Try one of these prompts:

- “Protect all my SOL holding at 2x.”
- “How protected is my BTC right now?”
- “Remove my BNB protection.”
- “Check ETH market conditions before I decide what to do.”

The public demo and hosted MCP surface are designed for inspection without account access. Binance account actions require a local runtime with the required credentials and explicit live-execution settings.

For a local MCP server, use the command `node` with the argument `/absolute/path/to/kertel/apps/telt/dist/mcp.js`. Start in fixture mode with `TELT_MODE=fixture` and set `TELT_OWNER_WHATSAPP` to the owner number. The full walkthrough is at [telt.site/connect](https://telt.site/connect).

Configure `TELT_BINANCE_MCP_TOKEN` in the local runtime for Binance Agent OS account access. Optional paid research uses `TELT_X402_PRIVATE_KEY`. See [.env.example](.env.example), and keep credentials out of browser forms, screenshots, and public chat.

For connected account workflows, the MCP client supplies the model reasoning. Telt's separate autonomous hunting workflow uses its own Anthropic configuration.

Live execution requires both `TELT_MODE=live` and `TELT_LIVE_EXECUTION=true`. These settings do not approve an individual order. Do not enable live execution for a demonstration.

## Verify receipts

The browser verifier runs locally. It recovers the EIP-191 signer over the canonical attestation and compares it with the claimed address. The verifier does not ask Telt's server to judge its own receipt.

| Check | Scope |
| --- | --- |
| Signature | Integrity of signed fields relative to the claimed address, not identity or truth |
| V2 linkage | The research run, decision digest, and proposal hash are included in the signed claims |
| Payment | A reference to inspect; the offline verifier does not check settlement |
| Evidence digest | A commitment; it does not independently verify provider origin or data accuracy |
| Order reference | A claim that requires exchange account records |
| Claimed time | Signed text; it is not an independently anchored decision timestamp |

V1 receipts remain supported. V2 trade receipts additionally sign `researchRunId`, `decisionDigest`, and `proposalHash`. A receipt does not prove that a prediction was correct, that research preceded a trade, or that a provider delivered authentic data. Telt makes no first-in-market or trustless-reasoning claim.

## Reproduce the offline proof

Use Node.js 22.17, matching the runtime image:

```bash
npm ci
npm run check
npm run prove
node scripts/build-verifier.mjs
```

The `prove` command runs the fixture research runtime with recorded responses, a public test key, a fixed clock, and an in-memory database. It stores explicit `NO_TRADE` decisions and generates `web/lib/demo.json`. The fixture conclusion is scripted so the proof remains deterministic. No network call, payment, or order is made.

The generated fixture and browser verifier remain under `web/lib` for reproducible offline proof. The homepage uses `POST https://mcp.telt.site/demo` for the live demo. Telt reads a public Binance market snapshot, sends bounded evidence through its server-side Anthropic model seam, validates the structured verdict, and returns the result.

## Run the web app locally

```bash
cd web
npm ci --ignore-scripts
npm run build
npm start -- -p 3100
```

## Current limits

- Binance spot market orders and Agent OS USDⓈ-M futures are supported. Exchange filters and configured symbol restrictions apply.
- One-symbol Spot hedges work only when the same USDT pair trades on both Spot and USD-M Futures. Telt refuses Spot-only tokens and existing Futures positions rather than mixing exposures.
- Hedge coverage is quantity based. Fees, funding, price basis, and later Spot balance changes can create drift. `telt_hedge_status` reports the current two-leg state.
- A hedge remains open until the user asks Telt to remove it. Automatic timed removal is not active in this version.
- Account-wide loss and total exposure accounting are unavailable. Direct confirmed spot orders enforce per-order and balance checks. Discretionary live entries remain paused until full accounting exists.
- Futures proposals do not mutate margin or leverage. Those changes occur after confirmation and fresh position and quote checks. Codes are isolated by runtime and expire after two minutes.
- Approved long-position exit plans can scale out and trail stops. Protective exits do not wait for paid research. Concurrent sweeps coalesce. Incomplete fills require reconciliation before progress is marked complete.
- Stops require a running daemon and cannot guarantee a price, breakeven, or profit. Active tenant mandates prevent idle eviction. HTTP credentials are not persisted across restarts, so use a dedicated daemon for continuity.
- Review derives rule-based notes from recorded outcomes. It does not represent training or demonstrated performance improvement.

## Track A presentation

Start on the public site without account access and run one live market question. Then connect ChatGPT or Codex to a local Telt MCP runtime backed by a funded demo sub-account. Say “protect all my SOL at 2x,” review the two legs, type the returned confirmation code, and show the Spot and Futures account changes in Binance. Ask “how protected is my SOL?” to show the combined state, then ask Telt to remove the protection and show the reduce-only close. Identify Binance Agent OS as the account and execution integration throughout.

[Submission walkthrough](docs/TRACK_A_DEMO.md) · [Implementation notes](docs/IMPLEMENTATION_2026-09-08.md) · [Runbook](docs/RUNBOOK.md)
