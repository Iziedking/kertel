# Telt

Autonomous position protection for Binance Agent OS. Telt watches a Spot holding against an isolated USD-M Futures hedge, records every decision, and stops when account state is stale or uncertain.

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

For the full agent workflow, connect ChatGPT, Codex, Claude, or another MCP client to `https://mcp.telt.site/mcp`. Ask in plain language: “protect my SOL,” “check my protection,” or “show my Memory Lane.”

The public site and hosted MCP endpoint cannot access a user's Binance account. Live account actions run from a local Telt MCP process connected to that user's Binance Agent OS session.

## Live capabilities

- Spot market orders with exchange filters, balance checks, slippage bounds, one-use confirmation codes, and reconciliation.
- Agent OS USDⓈ-M Futures positions with isolated margin, a configured margin multiplier ceiling, and reduce-only closes.
- One-symbol protection for any USDT pair listed on both Spot and USD-M Futures. Telt refuses Spot-only pairs and conflicting existing Futures positions.
- Protection Watch, which checks both legs for free. An explicit investigation buys paid research and attaches it as context without giving research authority over the hedge.
- Guard Mode, an explicit, versioned mandate that survives restarts, expires automatically, records checkpoints, and classifies exposure as protected, underhedged, overhedged, unprotected, or unknown.
- Memory Lane, which records proposals, openings, checks, investigations, and removals for the next session.
- Approved exit plans that can scale out, ratchet stops, and halt on unknown or incomplete fills.

## How it works

1. Say what to protect, for example “guard my SOL at 2x while I am away.”
2. Telt verifies that `SOLUSDT` trades on both Binance Spot and USD-M Futures, then reads the actual SOL balance.
3. It calculates the short quantity from the requested coverage and checks the Futures lot size, minimum position value, Telt's cap, leverage ceiling, and available USDT margin.
4. It shows the Spot holding, target short, resulting net exposure, required margin, and available Futures cash. No account setting or order changes at this point.
5. A human types the one-use code. Telt rechecks the position and price, forces isolated margin, sets the approved leverage, and opens the short.
6. Ask “check my SOL protection” to read both legs as one position for free. Ask “investigate my SOL protection” when you want Telt to spend research points on outside market context.
7. For unattended protection, approve Guard Mode once with `telt_guard_arm`. Telt stores the mandate, runs it from the local daemon, and exposes `telt_guard_status` and `telt_guard_revoke` for inspection and control.
8. Ask for the SOL Memory Lane to see the proposal, opening, checks, investigations, and removal in time order. Ask “remove my SOL protection” to close the Futures leg with a reduce-only order.

This path is generic. It supports any `...USDT` asset that Binance currently lists on both Spot and USD-M Futures. BTC, ETH, BNB, and SOL are examples, not a hardcoded allowlist. A Spot-only token cannot use this hedge path.

Protection Watch starts with Binance account facts and spends nothing. Paid research runs only when the user asks Telt to investigate the protected position. It explains market context, but it never opens, resizes, closes, delays, or vetoes the hedge. Missing provider coverage therefore leaves the protection workflow intact.

Memory Lane turns the audit journal into one readable position story. Telt records each protection proposal, confirmation, account check, paid investigation, and removal locally. An MCP client with Agent Memory can store that lane so it follows the user across sessions without giving Telt the memory credential.

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
- “Check my SOL protection.”
- “Investigate my SOL protection and show its Memory Lane.”
- “Remove my BNB protection.”
- “Check ETH market conditions before I decide what to do.”

The public demo and hosted MCP surface are designed for inspection without account access. Binance account actions require a local runtime with the required credentials and explicit live-execution settings.

For a local MCP server, use the command `node` with the argument `/absolute/path/to/kertel/apps/telt/dist/mcp.js`. Start in fixture mode with `TELT_MODE=fixture` and set `TELT_OWNER_WHATSAPP` to the owner number. The full walkthrough is at [telt.site/connect](https://telt.site/connect).

Configure `TELT_BINANCE_MCP_TOKEN` in the local runtime for Binance Agent OS account access. Optional paid research uses `TELT_X402_PRIVATE_KEY`. See [.env.example](.env.example), and keep credentials out of browser forms, screenshots, and public chat.

For connected account workflows, the MCP client supplies the model reasoning. Telt's separate autonomous hunting workflow uses its own Anthropic configuration. Discretionary live entries remain paused until account-wide risk accounting is complete.

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

## Current limits and roadmap

- Protection covers one Spot holding at a time. It does not reconcile total account exposure or multi-asset risk.
- Coverage is quantity based. Fees, funding, price basis, liquidation, and later balance changes can create drift.
- Guard Mode is opt-in and bounded to one symbol, isolated USD-M Futures, a coverage range, a notional ceiling, leverage, cooldown, and expiry. Opening and resizing remain behind the live execution gate and existing exchange reconciliation checks.
- Account-wide loss and total exposure accounting, WebSocket event ingestion, transition notifications, and multi-symbol mandates remain roadmap work.
- Paid research depends on verified provider mappings. Telt reports missing coverage instead of guessing an identifier.
- Unknown or incomplete fills halt activity until reconciliation. No system can guarantee a fill price, profit, or liquidation outcome.

Roadmap: account-wide loss and exposure accounting, WebSocket plus polling reconciliation, transition alerts, wider verified research coverage, hedge performance reconciliation, and operator pause, resume, and export controls.

Telt refuses unsupported pairs, conflicting Futures positions, insufficient margin, and orders outside configured limits. A hedge reduces directional exposure; fees, funding, price differences, liquidation risk, and later balance changes can affect the result.

The current release stays with one holding, one hedge, and one explicit approval path so every live step can be inspected.

## Track A presentation

Start on the public site without account access and run one live market question. Then connect ChatGPT or Codex to a local Telt MCP runtime backed by a funded demo sub-account. Say “protect all my SOL at 2x,” review the two legs, type the returned confirmation code, and show the Spot and Futures account changes in Binance. Ask “how protected is my SOL?” to show the combined state, then ask Telt to remove the protection and show the reduce-only close. Identify Binance Agent OS as the account and execution integration throughout.

[Submission walkthrough](docs/TRACK_A_DEMO.md) · [Implementation notes](docs/IMPLEMENTATION_2026-09-08.md) · [Runbook](docs/RUNBOOK.md)
