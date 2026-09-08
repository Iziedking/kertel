# Telt

**The first trading agent whose reasoning you can verify without trusting it.**

Telt buys its own research with real money over x402, and every conclusion it reaches comes with a signed receipt. The payment is a transaction on a public chain. The evidence is committed to by hash. The conclusion is signed by the same key that paid. Anyone — with no account, no credentials, and nothing installed — can check that chain and see for themselves that the agent did the work before it traded.

That is the part nobody else has. Every AI trading agent is asked the same question and none of them can answer it: *how do I know it did not invent the thesis?* Logs do not answer it. A log is written by the same program that would have lied, kept by the same operator who benefits from the lie, and editable afterwards by either.

```
TELT-ATTESTATION-1
symbol=ETHUSDT
goal=price_check
at=2026-09-08T02:52:01.134Z
agent=0xd2f6393c6a916acb98057a5920952084b838cfd1
provenance=8c07355f4d640a4f7654116add00fa63b89e2597fa41d958906870ee36436442
spent=0.01
decision=EVIDENCE_ONLY
order=none
payment=coingecko:base-usdc:0x8f6d21822954bc2d9606a6e4a7f9c9464e62647f1c73bfb2059b3a72b486b873:0.01
sig=0x9941c368ddddfc8621fadb557b384d7913ac715c91c4049f11012c5795f8badf01...
```

That is a real attestation from a real run. The payment is [on Basescan](https://basescan.org/tx/0x8f6d21822954bc2d9606a6e4a7f9c9464e62647f1c73bfb2059b3a72b486b873). Paste the block into `telt_verify` and it recovers the signer, confirms it matches the address that paid, and hands you the explorer links. Change one character of the verdict and it reports the address that *actually* signed it, and tells you not to act on it.

Four facts, none of which come from Telt:

| Link | Who can check it | What it rules out |
| --- | --- | --- |
| x402 payment | anyone, on BNB Chain or Base | Research that never happened |
| Evidence digest | anyone holding the receipt | Sources swapped after the outcome was known |
| Signature | anyone, with any wallet tool | A conclusion attributed to the wrong agent |
| Block timestamp | anyone | A thesis backdated to fit a trade |

It only works because x402 payments and Agent OS orders are both independently auditable. It is what this stack is *for*.

**How it works, end to end:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Everything else it does

A trading agent for **Binance Spot and USDⓈ-M futures** that finds candidates, buys its own research, refuses what it cannot justify, and manages positions on its own once you approve a plan.

Market orders only, and futures runs only on the Agent OS rail. Both are deliberate limits rather than unfinished edges, and `telt_status` will tell you so on any machine you run it.

It trades whatever Binance lists. There is no symbol allowlist to maintain: every proposal is checked against the live `exchangeInfo`, so a halted or delisted pair is refused on the day it halts.

It runs as an MCP server and trades through **Binance Agent OS**. Claude Code, Claude, Codex, ChatGPT and VS Code become the reasoning layer; Telt is the part that handles money, and it is deterministic.

```
You:     research ETH, should I buy
Claude:  [calls telt_research]

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

## It trades through Agent OS

Orders go out through the Agent OS MCP server and land in the **Agentic sub-account**. The token Binance issues carries these scopes and no others:

```
mcp:account:read  mcp:spot:trade  mcp:margin:loan
mcp:futures:trade mcp:wallet:transfer mcp:master:read
```

There is no withdrawal scope to grant. That is a stronger guarantee than an API key with the withdrawal box unticked, because it is not a box anybody can later tick.

Three things about the live server contradict its own documentation, and each one breaks code written from the docs:

- Tool names use dots. `spot.newOrder`, not `spot_newOrder`. The underscore form is what MCP clients rename them to.
- `tools/list` returns fifty "always exposed" tools in alphabetical order, which stops partway through `margin.*`. Every `spot.*` tool is past that cut and invisible there.
- So everything goes through `tool_execute`. Calling `spot.exchangeInfo` directly answers "Tool not found".

The token is a plain bearer credential that lasts thirty days, with no refresh grant advertised. A server runs unattended for a month, then needs one browser sign-in. `telt_status` says which rail it is on, and a lapsed token refuses with the expiry named rather than failing obscurely.

Telt falls back to a Binance API key when no Agent OS token is set, because a machine whose token lapsed still has to manage open positions. Both paths implement the same interface and share the same parsers, so refusals read identically either way.

## What it does that other agents don't

**Its reasoning is verifiable by a stranger.** Covered above, and it is the one that matters. Everything below is what a good agent should do; that one is what no other agent can.

**It pays for its own data and tells you what it didn't buy.**

Research runs on a ladder. Read the free Binance price first. If nothing corroborates it, buy one independent price for a cent. If the two disagree by more than 100 bps, buy a third to break the tie. Buy Nansen Smart Money flows only when the question is whether to trade, never to settle a price argument, because flows cannot arbitrate a price.

A price check costs $0.01. A full trade thesis costs $0.06. The receipt shows every source it skipped and what that saved, so a cheap run reads as discipline instead of laziness.

**The model reasons. It never touches the money.**

Telt has a closed catalogue of the calls it can make. No code path turns a chat message or a model output into a URL, an order size, or a symbol. A prompt injection that reaches the model reaches tools that prepare a proposal you then decline.

The model also never writes the verdict. Telt returns evidence with a receipt; Claude reads it and forms the view. That is why there is no LLM key in this repo.

**It manages a position the way a trader does.**

Approve one plan and Telt runs it without asking again:

- **Scales out.** A third at +25%, a third at +50%, the rest at +100%. Being right about direction and wrong about magnitude still pays.
- **Ratchets the stop.** As the position gains, the stop follows it up and never back down.
- **Moves to breakeven.** Once up 20%, the stop sits at what you paid. From there the trade cannot lose, which is what lets you hold it long enough to be worth holding.
- **Asks why before a protective exit.** A stop hit by a 5% lurch between two checks is a different event from one reached by slow drift. On an abrupt move Telt buys the evidence first, exits anyway, and files what it found next to the decision.

**It carries its state to any machine.**

Telt's working state lives in a local database, so a fresh Claude Code session on another laptop would normally start blank and sit idle over a live position. `telt_snapshot` emits that state as text you store in your own memory service. `telt_restore` picks the positions back up mid-flight, including the high-water mark that a trailing stop depends on.

Restore treats the snapshot as intent and the exchange as truth. A position you sold by hand since Tuesday comes back marked unfulfillable, not as something the monitor goes looking to sell.

**It remembers, across machines and across sessions.**

Telt's working state lives in a local database, so a fresh session on another
machine would start blank. [Agent Memory](https://agentsqa.xyz) closes that gap.
It is a portable memory service ([`agent-memory-connect`](https://github.com/Iziedking/Agent-QA),
by the same author as Telt) that keeps a passphrase in the OS keychain and
attaches identity headers through a local proxy, so no secret sits in a config
file.

The division of labour matters:

- **Telt owns the facts.** Every plan, every exit, every fill price, recorded
  when it happens. Not a model's recollection of events; the events.
- **Agent Memory owns the portability.** It carries a snapshot and a digest
  between machines and between agents.
- **Claude is the bridge.** It recalls at the start of a session, hands what it
  found to `telt_learn` and `telt_restore`, and stores the result back.

Telt deliberately holds no memory credential of its own. Taking the passphrase
would break the one property the connector exists to provide.

**It keeps a record you can hold it to.**

Every exit is recorded when it fires: fill price, move against entry, how much was handed back from the peak. A day later Telt answers the question that had no answer at the time. Did the price climb back above where it sold?

If it did, that stop cost money. `telt_review` counts those specifically, because four of them means the stop is not protection, it is a leak.

```
Stops that recovered within a day: 3 — the expensive kind of mistake

What to do differently
  - 3 of 4 stops on ETHUSDT recovered above the exit within a day. The stop may be
    inside normal noise for this pair. Consider a wider one, or a trailing stop that
    only arms after a real gain.
```

## Use it without installing anything

Telt runs as a public MCP server. Point any client at it:

```bash
claude mcp add telt --transport http https://mcp.telt.site/mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.telt]
url = "https://mcp.telt.site/mcp"
```

Three tiers, and the boundaries are the design rather than an afterthought:

**Anyone, no credentials.** `telt_verify` and `telt_scan`. Verification has to work for someone who does not trust the thing that produced the proof — requiring them to install it first would defeat the point. Market reads are free because they cost nothing and reveal nothing.

**Your own Agent OS token.** Send it as `X-Telt-Binance-Token` and you get the full agent against your own account. The token is never written to disk. Each caller gets a separate database named by a hash of the token rather than the token, so two users cannot see each other's positions and a disk dump leaks no credentials.

**Nobody gets the operator's wallet.** Paid research spends real money from the key in the server's environment, so an anonymous caller who could spend it would drain it within the hour. Callers get every capability except that one, and are told why.

Run your own:

```bash
TELT_HTTP_PORT=8787 npm run serve
```

It speaks plain HTTP on purpose — whatever already terminates TLS for your domain does that job better than a process that also holds trading credentials.

## How a session goes

```
1.  recall              Claude pulls your Telt snapshot from Agent Memory
2.  telt_restore      positions resume, mid-flight, with peaks intact
3.  telt_watch        what you hold, and what has no exit plan
4.  telt_research     evidence with a cost receipt; Claude draws the conclusion
5.  telt_propose      a priced order and a one-use code. Nothing is placed.
6.  telt_confirm      you type the code. This is the only path to an order.
7.  telt_plan_exit    a scale-out plan showing the real price each leg fires at
8.  telt_arm          you approve it once. From here it acts alone.
9.  telt_snapshot     store it back, so the next machine picks up from here
```

Steps 5 and 6 exist because a proposal is hashed when shown and re-hashed when confirmed. If any number moved in between, the code stops matching and the order is refused rather than executed against different figures.

## Futures

`telt_futures_open`, `telt_futures_confirm`, `telt_futures_close` and `telt_futures_positions` follow the same propose-then-confirm spine as spot. What differs is what has to be true before a code is issued, because a futures position can lose more than it cost.

Binance ships ETHUSDT at **20x on cross margin**, where the entire futures wallet backs the position and a 5% move is the whole margin. Read from the live account:

```json
{"symbol":"ETHUSDT","leverage":"20","marginType":"cross","markPrice":"0.00000000"}
```

Telt sets isolated margin and a leverage ceiling *before* it will issue a code, and refuses to open if either could not be set. It never opens into the default and hopes.

Four gates that spot does not need:

- **Isolated margin, always.** A failure to set it is a refusal, not a warning.
- **A leverage ceiling** in `TELT_MAX_LEVERAGE`, default 3. Configuration, not something the model can argue its way past.
- **A cap on the position, not the margin.** Leverage means 17 USDT of margin controls a 50 USDT position, so the spot per-trade cap does not bound the risk. `TELT_MAX_FUTURES_NOTIONAL` bounds the position itself.
- **Liquidation shown before you agree.** The proposal states where the exchange would close the position for you, and says so plainly when that is inside an ordinary day's range.

Closes are **reduce-only**, so a close that arrives twice cannot flip the position onto the other side. Telt will not average into a position you did not plan: an open position is a refusal, not a top-up.

That `markPrice` of zero above is not a quirk to note in passing. A flat position reports a zero mark, and flat is the state every first entry is sized from — so sizing off the position's own mark meant no position could ever be opened. Telt reads the mark from the price ticker instead, and a test pins it.

## What it refuses to do

Refusals are returned values, not exceptions, and there are 47 of them with stable codes. The ones that matter most:

| Situation | What happens |
| --- | --- |
| Exchange price unreadable | Refuses having spent $0.00. A trade was already impossible. |
| Price sources disagree past 100 bps | Buys one tiebreak, then refuses at $0.02. Never buys flows to settle a price. |
| Order below Binance's 5.00 USDT minimum | Refused, with the shortfall named. Checked against the venue's own 5-minute average, not the last trade. |
| Order timed out | `EXECUTION_RESULT_UNKNOWN`. Never reported as a failure. Telt stops itself and reconciles using the client order id it chose before sending. |
| Research payment signed, never confirmed | Charged pessimistically, kill switch engaged. Telt cannot say what it spent, so it stops spending. |
| Anything unreconciled | `telt_resume` refuses until it is resolved. |

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
claude mcp add telt -- node /absolute/path/to/apps/telt/dist/mcp.js
```

Copy `.env.example` to `.env`. Every variable is optional; an unset one disables its own feature and says so in `telt_status`. A variable that is set but malformed is a startup error naming the variable, because an operator who typed `TELT_MAX_TRADE_NOTIONAL=fifty` believes a limit is in force that is not.

To trade you need two things:

1. An Agent OS token in `TELT_BINANCE_MCP_TOKEN`, from one browser sign-in. Or a Binance API key with Reading and Spot Trading enabled and **Withdrawals off**, if you would rather not re-authenticate monthly.
2. USDT in the account. The Agentic sub-account starts empty and is funded at `binance.com/en/my/sub-account/asset-management/transfer`. The exchange minimum is 5.00 and the default per-trade cap is 25.00.

Research payments need a separate EVM key funded with a few dollars of USDC on Base, or U on BNB Smart Chain to route through B402. Payments are gasless. Telt refuses to start if the two keys are the same, because the research wallet spends cents and the exchange key moves the trading balance.

`docs/GO-LIVE.md` has the full runbook.

## What works right now

Verified on 2026-09-08 against live endpoints.

| Capability | State |
| --- | --- |
| Research over x402 (CoinGecko, CoinMarketCap, Nansen) | Live. All four providers probed, pins matched, prices confirmed. |
| Binance B402 rail | Live. CoinMarketCap and Nansen settle in $U on BNB Smart Chain. |
| Free Binance market data | Live. |
| Spot order execution via Agent OS | Wired and verified against the live server: filters, book and account all read through `tool_execute`. Needs funding. |
| Autonomous exits | Wired and tested. Runs behind the same write gate. |
| Portable state | Working. Round-trip tested across two machines. |
| Binance Agent OS MCP | Telt's execution path. Verified live on 2026-09-07 against the Agentic sub-account. |
| The Graph pool data | Not wired. No subgraph chosen, and the receipt says so rather than implying onchain evidence. |
| Daily loss and exposure caps | Not enforced yet. Both are passed as zero. The per-trade cap and balance check do apply. |
| Limit orders | Modelled throughout, not wired. Market orders only. |
| USDⓈ-M futures | Wired and tested. Isolated margin and a leverage ceiling are set before a position can open; the proposal shows the liquidation price before you agree. Agent OS rail only. |
| Margin, convert | Not used. The Agent OS token carries those scopes; Telt touches neither. |
| Symbols | Anything Binance lists as TRADING, checked live per proposal. Paid research providers refuse an unmapped symbol by name rather than guessing its id. |
| Proof of research | Live. Verified end to end against a real 0.01 USDC payment on Base: signed, verified from the text alone, and a copy with the verdict altered correctly reported as forged. |
| Public MCP over HTTP | Working. Stateless, multi-tenant, tokens never written to disk. Anonymous callers can verify proofs and read markets, nothing else. |
| Discovery (`telt_scan`) | Live. 3,695 pairs read in one free call, 81 above a five million volume floor. |
| Verified provider ids | ETHUSDT and BTCUSDT only. Any other symbol trades normally but comes back with venue data alone, and the receipt says so rather than implying corroboration. |

Getting an Agent OS token takes one browser sign-in. Connect the MCP server to any supported client, authorise, and copy the `accessToken` the client stored:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
```

In Claude Code it lands in `~/.claude/.credentials.json` under `mcpOAuth`. Put it in `TELT_BINANCE_MCP_TOKEN`.

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
apps/telt    the MCP server, the monitor, and durable state.
```

`packages/core` takes its clock, hasher and network as arguments, which is why the entire policy, sizing, proposal and confirmation logic is tested without any of them. Fixture mode is not a separate code path; it is the same executor holding a different payment client, so a run with no wallet still exercises the merchant pins, the rail selection and the per-asset decimals.

Money is never a float. The spend ledger stores integer atoms at micro-dollar scale and adds them in SQL as integers, with a test that adds a hundred cents and demands exactly one dollar.

## Running it on a server

A laptop only manages positions while it is on. `telt-daemon` is the same
runtime with no protocol attached: it opens the same database, starts the
monitor, and stays up.

```bash
cp .env.example .env      # fill in the token and limits
docker compose up -d
docker compose logs -f
```

The first log line says whether it will actually trade, and the `degraded` array
names anything missing. Every fifteen minutes it logs what it is managing, so a
wedged daemon and a quiet market do not look the same.

The daemon holds no port open and accepts no input. Talking to Telt is the MCP
server's job, and that is stdio only. `docs/DEPLOY.md` has the full setup,
including reaching one database from both.

## Verify it yourself

```bash
npm run probe:providers   # live 402 challenges from all four providers. Free, signs nothing.
npm run probe:adapters    # both research ladders end to end, live Binance price.
npm run probe:scan        # every pair on the venue, ranked. Free.
npm run probe:proof       # buys $0.01 of research, signs it, verifies it, then forges it
npm run probe:futures     # live futures read and a priced proposal. Sends no order.
npm run check             # 497 tests
```

`probe:proof` is the one worth running. It spends a real cent, prints the attestation, verifies it as a stranger would, then alters one field and shows the verifier catching it and naming the address that actually signed.

The daemon holds no port open, but `npm run serve` does: that is the public MCP endpoint, and the two are separate processes on purpose.

`fixtures/x402/live-quotes/` holds the raw 402 challenges captured from each provider, and `fixtures/binance/exchange-info-2026-09-07.json` holds the real ETHUSDT and BTCUSDT filters read from the authenticated Binance MCP. Tests run against those, not against invented payloads.

## Licence

MIT.
