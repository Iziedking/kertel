# Telt

**A Binance AI agent that researches with a budget and leaves an inspectable decision trail.**

Telt connects an MCP client to Binance Agent OS. The client model reasons; Telt selects research sources, enforces spending limits, stores explicit decisions, and checks the exact order the user approves.

[Try the demo](https://telt.site/#demo) · [Verify a receipt](https://telt.site/verify) · [Connect](https://telt.site/connect)

## The workflow

1. Ask a precise question. A price check and a trade investigation need different information.
2. Buy the next useful evidence. Start with the free venue quote, cross-check independently, and add flow data for a trade question. Receipts list cost and skipped sources. Prices and availability may change.
3. Record a decision with telt_decide: research run ID, cited evidence IDs, conclusion, rationale and invalidation conditions. The client supplies reasoning; Telt validates its references and persists an immutable record.
4. Pass the decision ID to telt_propose. Confirmation binds the research run, evidence digest, decision digest, order size, mode, policy and expiry. A NO_TRADE decision cannot justify a BUY.
5. Recheck before execution. Refresh market/account data, reject stale evidence or changed limits, consume confirmation once, and persist the exchange result. Unresolved orders stop further execution.

Direct, explicitly requested orders can omit research. Their receipts say so. Pre-send quote checks cannot guarantee a market order's fill price.

## What verification establishes

The browser verifier runs locally. It recovers the EIP-191 signer over the canonical attestation and compares it with the claimed address; it does not ask Telt's server to judge itself.

| Check | Scope |
| --- | --- |
| Signature | Integrity of signed fields relative to the claimed address, not identity or truth |
| V2 linkage | The research run, decision digest and proposal hash are included in the signed claims |
| Payment | A reference to inspect; the offline verifier does not check settlement |
| Evidence digest | A commitment, not independent provider-origin or data-accuracy verification |
| Order reference | A claim requiring exchange account records |
| Claimed time | Signed text, not an independently anchored decision timestamp |

V1 receipts remain supported. V2 trade receipts additionally sign researchRunId, decisionDigest and proposalHash. Neither proves a prediction was right, research preceded a trade, or a provider delivered authentic data. No first-in-market or trustless-reasoning claim is made.

## Reproduce

Use Node.js 22.17, matching the runtime image:

    npm ci
    npm run check
    npm run prove
    node scripts/build-verifier.mjs

The prove command runs the real fixture research runtime with recorded responses, a public test key, a fixed clock and an in-memory database. It stores explicit NO_TRADE decisions and generates web/lib/demo.json. The conclusion is scripted, not an LLM output. No network call, payment or order is made.

The public fixture and generated browser verifier are included under web/lib so the standalone site can build without private backend state. Regenerate them after related core changes.

    cd web
    npm ci --ignore-scripts
    npm run build
    npm start -- -p 3100

## Connect an MCP client

After building, add a local server with command node and argument /absolute/path/to/kertel/apps/telt/dist/mcp.js. Start with TELT_MODE=fixture and set TELT_OWNER_WHATSAPP to your owner number. The full setup is at [telt.site/connect](https://telt.site/connect).

Configure TELT_BINANCE_MCP_TOKEN in the local runtime environment for Binance Agent OS account access. Optional paid research uses TELT_X402_PRIVATE_KEY; never fund or reuse the fixture key. See [.env.example](.env.example). Keep all credentials out of browser forms, screenshots and public chat.

The MCP client supplies research reasoning without a server-side LLM key. The separate hunting workflow uses Anthropic configuration; that feature is not a no-LLM-key feature.

Live execution requires both TELT_MODE=live and TELT_LIVE_EXECUTION=true. Configuration is not confirmation of an individual order. Do not enable live execution merely to demonstrate the product.

## Current limits

- Binance spot market orders and Agent OS USDⓈ-M futures. Exchange filters and configured symbol restrictions apply.
- **Account-wide loss and total exposure accounting are unavailable.** Direct confirmed spot orders enforce per-order and balance checks. Discretionary live entries are paused until full accounting exists.
- Futures proposals do not mutate margin/leverage. Those changes occur after confirmation and fresh position/quote checks. Codes are isolated by runtime and expire after two minutes.
- Approved long-position exit plans can scale out and trail stops. Protective exits do not wait for paid research. Concurrent sweeps coalesce; incomplete fills require reconciliation before progress is marked complete.
- Stops require a running daemon and cannot guarantee a price, breakeven or profit. Active tenant mandates prevent idle eviction, but HTTP credentials are not persisted across restarts; use a dedicated daemon for continuity.
- Review derives rule-based notes from recorded outcomes. It is not training or demonstrated performance improvement.

## Track A presentation

Compare the two labelled fixture questions, inspect the NO_TRADE decision, then verify the recorded sample and tamper with its conclusion. For the real agent portion, show your MCP client recording a decision and preparing an order in fixture mode. Identify Binance Agent OS as the execution/account integration.

[Submission walkthrough](docs/TRACK_A_DEMO.md) · [Implementation notes](docs/IMPLEMENTATION_2026-09-08.md) · [Runbook](docs/RUNBOOK.md)
