# Kertel

A trading agent for Binance Spot that buys its own research, refuses what it cannot justify, and manages positions on its own once you approve a plan.

It runs as an MCP server. Claude Code, Claude, Codex, ChatGPT and VS Code become the reasoning layer; Kertel is the part that handles money, and it is deterministic.

```
You:     research ETH, should I buy
Claude:  [calls kertel_research]

Research: ETHUSDT

Sources read:
  Binance: 2488.11000000 (free)
  CoinGecko: 2505.66 ($0.01)
  Nansen Smart Money: 24h net flow 5400000.25 USD, 143 wallets ($0.05)

Not read:
  CoinMarketCap: not needed for this question, saved $0.01
  The Graph: not bought: no published subgraph covers ETHUSDT, saved $0.01

Cost: $0.06
  CoinGecko $0.01 via Base x402
  Nansen Smart Money $0.05 via Binance B402
Not spent: $0.02
```

Every line above came from a live run. The prices are real, the payments settle on chain over x402, and two of the four providers are paid through Binance's own B402 rail.

## What it does that other agents don't

**It pays for its own data and tells you what it didn't buy.**

Research runs on a ladder. Read the free Binance price first. If nothing corroborates it, buy one independent price for a cent. If the two disagree by more than 100 bps, buy a third to break the tie. Buy Nansen Smart Money flows only when the question is whether to trade, never to settle a price argument, because flows cannot arbitrate a price.

A price check costs $0.01. A full trade thesis costs $0.06. The receipt shows every source it skipped and what that saved, so a cheap run reads as discipline instead of laziness.

**The model reasons. It never touches the money.**

Kertel has a closed catalogue of the calls it can make. No code path turns a chat message or a model output into a URL, an order size, or a symbol. A prompt injection that reaches the model reaches tools that prepare a proposal you then decline.

The model also never writes the verdict. Kertel returns evidence with a receipt; Claude reads it and forms the view. That is why there is no LLM key in this repo.

**It manages a position the way a trader does.**

Approve one plan and Kertel runs it without asking again:

- **Scales out.** A third at +25%, a third at +50%, the rest at +100%. Being right about direction and wrong about magnitude still pays.
- **Ratchets the stop.** As the position gains, the stop follows it up and never back down.
- **Moves to breakeven.** Once up 20%, the stop sits at what you paid. From there the trade cannot lose, which is what lets you hold it long enough to be worth holding.
- **Asks why before a protective exit.** A stop hit by a 5% lurch between two checks is a different event from one reached by slow drift. On an abrupt move Kertel buys the evidence first, exits anyway, and files what it found next to the decision.

**It carries its state to any machine.**

Kertel's working state lives in a local database, so a fresh Claude Code session on another laptop would normally start blank and sit idle over a live position. `kertel_snapshot` emits that state as text you store in your own memory service. `kertel_restore` picks the positions back up mid-flight, including the high-water mark that a trailing stop depends on.

Restore treats the snapshot as intent and the exchange as truth. A position you sold by hand since Tuesday comes back marked unfulfillable, not as something the monitor goes looking to sell.

**It keeps a record you can hold it to.**

Every exit is recorded when it fires: fill price, move against entry, how much was handed back from the peak. A day later Kertel answers the question that had no answer at the time. Did the price climb back above where it sold?

If it did, that stop cost money. `kertel_review` counts those specifically, because four of them means the stop is not protection, it is a leak.

```
Stops that recovered within a day: 3 — the expensive kind of mistake

What to do differently
  - 3 of 4 stops on ETHUSDT recovered above the exit within a day. The stop may be
    inside normal noise for this pair. Consider a wider one, or a trailing stop that
    only arms after a real gain.
```

## How a session goes

```
1.  recall              Claude pulls your Kertel snapshot from Agent Memory
2.  kertel_restore      positions resume, mid-flight, with peaks intact
3.  kertel_watch        what you hold, and what has no exit plan
4.  kertel_research     evidence with a cost receipt; Claude draws the conclusion
5.  kertel_propose      a priced order and a one-use code. Nothing is placed.
6.  kertel_confirm      you type the code. This is the only path to an order.
7.  kertel_plan_exit    a scale-out plan showing the real price each leg fires at
8.  kertel_arm          you approve it once. From here it acts alone.
9.  kertel_snapshot     store it back, so the next machine picks up from here
```

Steps 5 and 6 exist because a proposal is hashed when shown and re-hashed when confirmed. If any number moved in between, the code stops matching and the order is refused rather than executed against different figures.

## What it refuses to do

Refusals are returned values, not exceptions, and there are 47 of them with stable codes. The ones that matter most:

| Situation | What happens |
| --- | --- |
| Exchange price unreadable | Refuses having spent $0.00. A trade was already impossible. |
| Price sources disagree past 100 bps | Buys one tiebreak, then refuses at $0.02. Never buys flows to settle a price. |
| Order below Binance's 5.00 USDT minimum | Refused, with the shortfall named. Checked against the venue's own 5-minute average, not the last trade. |
| Order timed out | `EXECUTION_RESULT_UNKNOWN`. Never reported as a failure. Kertel stops itself and reconciles using the client order id it chose before sending. |
| Research payment signed, never confirmed | Charged pessimistically, kill switch engaged. Kertel cannot say what it spent, so it stops spending. |
| Anything unreconciled | `kertel_resume` refuses until it is resolved. |

The kill switch survives a restart, and a restore never turns it off. Safety is per machine.

## Setup

Requires Node 22.16 or later.

```bash
npm install
npm run check          # 433 tests, typecheck
npm run probe:adapters # walks both research ladders, free, signs nothing
```

Register it with Claude Code:

```bash
claude mcp add kertel -- node /absolute/path/to/apps/kertel-plugin/dist/mcp.js
```

Copy `.env.example` to `.env`. Every variable is optional; an unset one disables its own feature and says so in `kertel_status`. A variable that is set but malformed is a startup error naming the variable, because an operator who typed `KERTEL_MAX_TRADE_NOTIONAL=fifty` believes a limit is in force that is not.

To trade you need two things:

1. A Binance API key with Reading and Spot Trading enabled and **Withdrawals off**. With withdrawals disabled the worst case of a full compromise is bad trades, not drained funds.
2. USDT in that account. The exchange minimum is 5.00 and the default per-trade cap is 25.00.

Research payments need a separate EVM key funded with a few dollars of USDC on Base, or U on BNB Smart Chain to route through B402. Payments are gasless. Kertel refuses to start if the two keys are the same, because the research wallet spends cents and the exchange key moves the trading balance.

`docs/GO-LIVE.md` has the full runbook.

## What works right now

Verified on 2026-09-07 against live endpoints.

| Capability | State |
| --- | --- |
| Research over x402 (CoinGecko, CoinMarketCap, Nansen) | Live. All four providers probed, pins matched, prices confirmed. |
| Binance B402 rail | Live. CoinMarketCap and Nansen settle in $U on BNB Smart Chain. |
| Free Binance market data | Live. |
| Spot order execution | Wired and tested. Needs an API key and funding. |
| Autonomous exits | Wired and tested. Runs behind the same write gate. |
| Portable state | Working. Round-trip tested across two machines. |
| Binance Agent OS MCP | Authorised and probed. Not yet Kertel's execution path; see below. |
| The Graph pool data | Not wired. No subgraph chosen, and the receipt says so rather than implying onchain evidence. |
| Daily loss and exposure caps | Not enforced yet. Both are passed as zero. The per-trade cap and balance check do apply. |
| Limit orders | Modelled throughout, not wired. Market orders only. |

Kertel trades through a Binance API key rather than the Agent OS MCP server. The MCP server authorises over browser OAuth and the credential lands in whichever client completed the flow; a monitor firing at 4am cannot re-run a browser login or borrow another client's session. The `BinanceClient` seam isolates this, so moving execution onto the Agentic sub-account is one file.

## How it is built

```
packages/core         zero dependencies. No clock, no network, no filesystem, no model.
  money/              bigint fixed point. Explicit rounding on every lossy operation.
  policy/             eight pure gates. 45 adversarial tests.
  research/           the escalation ladder. Deterministic, never model-driven.
  mandates/           scale-out, trailing stops, breakeven. 31 tests.
  receipts/           what the user reads.

packages/x402         the only module that can sign a payment.
packages/providers    one adapter per source. Validation returns null, never throws.
apps/kertel-plugin    the MCP server, the monitor, and durable state.
```

`packages/core` takes its clock, hasher and network as arguments, which is why the entire policy, sizing, proposal and confirmation logic is tested without any of them. Fixture mode is not a separate code path; it is the same executor holding a different payment client, so a run with no wallet still exercises the merchant pins, the rail selection and the per-asset decimals.

Money is never a float. The spend ledger stores integer atoms at micro-dollar scale and adds them in SQL as integers, with a test that adds a hundred cents and demands exactly one dollar.

## Verify it yourself

```bash
npm run probe:providers   # live 402 challenges from all four providers. Free, signs nothing.
npm run probe:adapters    # both research ladders end to end, live Binance price.
npm run check             # 433 tests
```

`fixtures/x402/live-quotes/` holds the raw 402 challenges captured from each provider, and `fixtures/binance/exchange-info-2026-09-07.json` holds the real ETHUSDT and BTCUSDT filters read from the authenticated Binance MCP. Tests run against those, not against invented payloads.

## Licence

MIT.
