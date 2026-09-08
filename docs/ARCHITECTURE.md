# How Telt works

Telt is a trading agent whose reasoning can be checked by someone who does not
trust it. Everything below serves that one sentence.

This document is written to be read by someone deciding whether to run it with
real money, so it says what Telt does *not* do as plainly as what it does.

---

## The shape of it

```
     you, in any MCP client                    nobody, at 4am
     (Claude · Codex · ChatGPT)                (the daemon)
              │                                      │
              │  plain speech                        │  telt_hunt
              ▼                                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │  TOOL SURFACE — 29 tools, one closed catalogue           │
   │  No model output ever becomes a URL, a size or a symbol  │
   └──────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  POLICY  — the gates. Pure functions, no I/O, no clock.  │
   │  symbol · notional · slippage · minimums · freshness     │
   │  budget · verdict · mandate · kill switch                │
   └──────────────────────────────────────────────────────────┘
        │                    │                      │
        ▼                    ▼                      ▼
   ┌─────────┐        ┌─────────────┐        ┌──────────────┐
   │ RESEARCH│        │  EXECUTION  │        │   AUTONOMY   │
   │  x402   │        │  Agent OS   │        │  the monitor │
   │  pays   │        │  spot+perps │        │  exits alone │
   └─────────┘        └─────────────┘        └──────────────┘
        │                    │                      │
        └────────────────────┴──────────────────────┘
                             ▼
   ┌──────────────────────────────────────────────────────────┐
   │  PROOF — every conclusion signed by the key that paid    │
   │  verifiable by anyone, from anywhere, forever            │
   └──────────────────────────────────────────────────────────┘
```

Four packages, and the split is a discipline rather than tidiness:

| Package | Holds | Never holds |
| --- | --- | --- |
| `@telt/core` | Every rule. Money, policy, mandates, budgets, verdicts, receipts, attestations | Network, clock, keys, database |
| `@telt/x402` | The wallet. The only code that can sign | Any decision about whether to spend |
| `@telt/providers` | One adapter per data source | Anything about trading |
| `apps/telt` | The runtime, the tools, the daemon, the HTTP server | Rules — it calls them, it does not restate them |

`core` is pure. It cannot reach the network, read a clock, or open a file, which
means every rule Telt enforces can be tested against fixed numbers rather than
against whatever the market happened to be doing.

---

## 1. Perceive — what is happening

**`telt_scan`** reads all 3,695 pairs in one free call, applies a liquidity
floor *before* ranking, and returns risers and fallers. The floor comes first
because a pair can print +400% on twelve thousand dollars of volume and would
top any unfiltered list. The receipt says in plain words that it is a momentum
screen and not a signal, worded so a model summarising it cannot quietly upgrade
it into advice.

**`telt_watch`** looks at what you already hold, including futures. It leads
with anything unprotected, because a leveraged position with no exit plan is the
only kind the exchange can close for you.

Both are free. Reads that cost nothing are chained without asking permission.

---

## 2. Research — buying the evidence

Telt pays for its own data over **x402**, on a ladder that escalates only when
the cheaper answer failed to settle the question:

| Tier | Cost | What | Why here |
| --- | --- | --- | --- |
| 0 | free | Binance price | The venue the order lands on |
| 1 | $0.01 | CoinGecko price | So the number is not one venue's opinion |
| 1 | $0.01 | CoinMarketCap | Bought **only** to break a >100bps disagreement |
| 2 | $0.01 | OpenPulse **safety** | Honeypot, mint authority, ownership |
| 2 | $0.01 | OpenPulse **sentiment** | What is being said, aggregated |
| 2 | $0.005 | OpenPulse **candles** | Range, and where price sits in it |
| 2 | $0.05 | Nansen Smart Money | Conviction, not price. The dearest, so the last |
| 3 | $0.01 | The Graph | Pool detail. Not wired; the receipt says so |

**Safety is bought before conviction.** It can only ever stop a trade, and
discovering a honeypot after paying five cents for flow data is paying to learn
things in the wrong order.

Three controls sit around every payment:

- **Recipient pinning.** A challenge naming an address Telt has not pinned is
  refused whatever else it says. OpenPulse was pinned only because its published
  catalogue and its live 402 challenge independently named the same address.
- **No guessed identifiers.** A ticker is ambiguous at every provider. With no
  verified id, that provider refuses **by name** on the receipt rather than
  pricing the wrong asset.
- **The receipt shows what was skipped**, and what that saved. A cheap run reads
  as discipline instead of laziness.

---

## 3. Reason — forming a view

**With you present**, your client is the reasoning layer. Telt returns evidence
and a cost receipt; it does not return a verdict, because the conclusion is
yours to draw and Telt's job is to make drawing it honest.

**Hunting alone**, there is no you, so the daemon asks a model itself — and that
changes what an answer is allowed to be. Only a small closed structure is
accepted:

```json
{ "action": "BUY_CANDIDATE | NO_TRADE | INSUFFICIENT_EVIDENCE",
  "confidence": 0-100,
  "because": "cites the actual figures read",
  "risks": ["never empty for a buy"] }
```

Each field prevents a specific failure. Three allowed words, because
interpreting a paragraph is where an agent talks itself into a trade. A
confidence floor of 70, because unsure is not a reason to spend. A `because`
long enough to have come from the evidence. And `risks` that must not be empty,
because everything worth buying has something wrong with it and a model listing
none has not looked.

The model gets **no tools**. Its entire output is a JSON object that is then
parsed, checked, and mostly rejected. Provider payloads reach it quoted inside a
block the instruction names as untrusted data.

A malformed answer, a timeout, an unreachable model: all the same outcome. No
trade, journalled, budget untouched.

---

## 4. Execute — the money

Everything runs through **Binance Agent OS**, over MCP. Spot and USDⓈ-M futures.

The spine never changes: **propose → code → confirm.** A proposal is hashed when
shown and re-hashed when confirmed, so a proposal whose numbers moved cannot be
confirmed against the old ones.

Futures adds four gates spot does not need, because a futures position can lose
more than it cost:

1. **Isolated margin, always.** Binance ships ETHUSDT at 20x on *cross*, where
   the whole wallet backs the position. Telt sets isolated first and refuses if
   it could not.
2. **A leverage ceiling**, in configuration, not something a model can argue
   past.
3. **A cap on the position, not the margin.** Leverage means a small margin
   controls a large position, so the spot per-trade cap does not bound it.
4. **Liquidation shown before you agree.**

Closes are **reduce-only**, so a close arriving twice cannot flip the position
onto the other side.

---

## 5. Manage — the part that works while nobody watches

Once you arm an exit plan, nobody types anything again. The monitor trims into
strength, ratchets a trailing stop, moves to breakeven, and closes on a stop —
identically on spot and futures, because the venue split is at the boundary and
everything above it is one copy of the code.

Three things it does that a trigger does not:

- **It asks why before a protective exit.** A stop reached by an abrupt lurch is
  a different event from one reached by slow drift. When the move is abrupt it
  buys cheap evidence *first* and files what it found next to the decision. It
  still exits — the stop is the stop — but the record says what was happening.
- **It writes down the times it did nothing.** An agent that only journals its
  trades is indistinguishable from one that got lucky.
- **It stops itself.** Kill switch, unreconciled order, an exchange that will not
  answer: all halt the loop rather than degrade it.

---

## 6. Act alone — the discretionary budget

This is the only place Telt opens a position nobody asked for, and the shape of
the permission matters more than the code.

You arm a budget once, explicitly, with a confirmation code. What changes is
granularity: you approve an amount and a set of rules, not each trade.

- **It is a budget, not a limit.** It depletes and does not refill. Ten dollars
  means ten dollars in total.
- **It expires.** Consent should not outlive the day it was given.
- **It bounds the loss.** Spot is charged the notional; futures the margin,
  because that is the number the exchange can take.
- **It refuses rather than trading smaller.** Shrinking a $3 idea into the $2
  that is left would put on a position neither you nor the analysis chose.
- **Everything else still applies.** Per-trade cap, slippage, daily loss, symbol
  gate, kill switch. The budget only ever *subtracts* permission.

The hunt loop, in the order that matters:

```
budget?  ──no──►  stop. (checked BEFORE spending on research)
   │yes
scan ──► one candidate, skipping what is held or looked at recently
   │
research (paid) ──► model verdict ──► below the floor? ──► pass, and RECORD IT
   │                                                            │
budget again (research took time)                        the missed-opportunity
   │                                                       record: what Telt saw
open ──► arm an exit IN THE SAME RUN                       and declined
   │            │
   │            └─ could not arm? close it again immediately
   │                     └─ could not close? kill switch, and say so loudly
   └─ sign the proof, attach the order
```

**One candidate per run.** A loop that considers ten and buys the best is a loop
that buys something every time it runs.

---

## 7. Prove — the part nobody else has

Every conclusion carries a receipt anyone can check, without an account and
without installing anything:

```
TELT-ATTESTATION-1
symbol=ETHUSDT
agent=0xd2f6…cfd1          ← the address that PAID and SIGNED
provenance=8c07355f…       ← commits to what each source returned
spent=0.01
decision=EVIDENCE_ONLY
order=none
payment=coingecko:base-usdc:0x8f6d21…:0.01    ← a real transaction
sig=0x9941c368…
```

Four facts, none of which come from Telt:

| Link | Checked by | Rules out |
| --- | --- | --- |
| x402 payment | anyone, on BNB Chain or Base | Research that never happened |
| Evidence digest | anyone holding the receipt | Sources swapped after the outcome was known |
| Signature | anyone, with any wallet tool | A conclusion attributed to the wrong agent |
| Block timestamp | anyone | A thesis backdated to fit a trade |

The chain runs one way and cannot be run backwards: **paid → read → concluded →
traded**, with the first and last links held by parties who have never heard of
Telt.

`telt_verify` checks *anyone's* attestation, not just Telt's own. It settles the
signature with arithmetic and returns explorer links for the payments — it will
not claim to have confirmed a blockchain it has not queried, because asserting
what you did not check is the self-attestation this whole feature replaces.

---

## 8. Remember — across machines and sessions

Telt's state lives in SQLite on one machine, so a fresh session elsewhere would
start blank and sit idle over live positions.

**Agent Memory is client-side by design.** Its identity and passphrase come from
your MCP client's configuration, so the secret never enters a conversation and
Telt's server never sees it. Telt therefore holds no memory credential at all.

The division:

- **Telt owns the facts.** Positions, high-water marks, what was sold, what it
  passed on and why.
- **Agent Memory owns portability.** Encrypted, on Walrus, yours on any device.
- **Your client is the bridge.** `telt_snapshot` emits state as text you store;
  `telt_restore` picks positions back up mid-flight, peaks intact.

What it learns from:

- `telt_review` grades exits 24 hours later — *did that stop sell a dip that
  recovered?* Four of those and the stop is not protection, it is a leak.
- **Verdicts it did not act on are recorded too.** An agent that writes down only
  its trades cannot tell you what it passed on, so it can never learn that it
  passes on the wrong things.

---

## What Telt does not do

Stated plainly, because an architecture that only lists strengths is marketing.

- **No DEX execution.** Agent OS has no DEX. Telt buys *onchain intelligence*
  about tokens — liquidity, deployer risk, holder concentration, smart-money
  swaps — and executes where it can do so safely. A swap path that moved real
  money without being properly tested would be worse than not having one.
- **No limit orders.** Modelled throughout, wired nowhere. Market only.
- **No shorts in exit plans.** Every trigger reads a gain as price rising above
  entry, so a short inverts all of them. Long-only, on both venues.
- **Paid coverage is not universal.** Only ETHUSDT and BTCUSDT have verified
  provider ids. Anything else trades normally and comes back with venue data
  alone — and the receipt says so rather than implying corroboration.
- **Daily loss and exposure caps are not enforced yet.** Both are passed as zero.
  The per-trade cap and the balance check do apply.
- **A verified proof does not mean a good trade.** It proves the agent held this
  conclusion over this evidence and paid for it before acting. A well-evidenced
  trade can still lose.

---

## Where it runs

```
telt.site              Vercel. The site and the verifier. Holds nothing.
mcp.telt.site          The public MCP endpoint. NO credentials, by design.
telt-daemon            Your agent. Your keys. Listens on no port at all.
```

The public endpoint is configured with an empty exchange token and an empty
research wallet. Anonymous callers verify proofs and read markets. A caller
bringing their own Agent OS token gets their own account and their own database,
named by a *hash* of the token so a disk dump leaks no credentials.

If that container were breached tomorrow, the attacker would hold nothing worth
having — which is the only thing that makes a public trading endpoint defensible.

Deploys run themselves: the full suite, then the image build, then SSH, then a
health check that must answer before the deploy is called green.
