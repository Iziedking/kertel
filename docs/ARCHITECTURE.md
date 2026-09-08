# How Telt works

Telt combines a reasoning client with deterministic research, proposal and execution code. The client model is not a trusted source of authority or truth. Its outputs are inputs to validation.

## Components

| Component | Responsibility |
| --- | --- |
| packages/core | Fixed-point money, source planning, policy, confirmation hashing, mandate rules, receipt canonicalization |
| packages/providers | Pinned provider recipes, parsing and evidence observations |
| packages/x402 | Research payment adapters and attestation signing |
| apps/telt | MCP and plugin surfaces, SQLite state, exchange adapters, runtime and monitor |
| web | Public market demo, MCP setup guide and local browser signature verification |

Core receives state and time as input. Exchange credentials and research keys remain in the runtime environment. The public frontend has neither.

## Evidence and decision lineage

A research request selects a goal and symbol. The planner chooses sources and applies research spending limits. The runtime stores a research record with a unique ID, symbol, mode, policy version, completion time, usable evidence IDs, expiry and provenance digest.

The client calls telt_decide with that run ID, a recommendation, rationale, cited evidence IDs, reasoning-source identifier and invalidation conditions. References outside the run and stale runs are refused. The immutable decision ID is derived from a canonical SHA-256 digest of these inputs. This records supplied reasoning; it does not independently judge prediction quality.

A research-driven spot proposal selects an explicit decision/run. It validates symbol, mode, policy and freshness. The confirmation hash includes the run ID and decision digest along with evidence digest and exact order fields. No code path chooses the most recent unrelated research as the order's basis. A direct user order can omit research and is labelled accordingly.

V2 trade attestations sign the research run, decision digest and proposal hash in addition to the original receipt fields. V1 research receipts are still accepted. Payment references are inherited from the exact bound research receipt when one exists.

## Execution boundary

Spot confirmation reconstructs the stored proposal and validates the token against its hash and owner. Before sending, it refreshes market, account and venue filters; checks freshness, expiry, account permission, balance and quote movement; rechecks safety; consumes the code once; and claims a durable idempotency key. Unknown results engage the kill switch and require reconciliation.

Quote checks are pre-send checks. A MARKET order can fill outside the observed tolerance. A returned order reference is not independent public proof of execution.

Futures proposals are read-only. Confirmation is isolated by runtime, checks safety, flat position, quote movement, expiry and current limits, then sets isolated margin/leverage before opening. A failed setting prevents the order, but preceding successful account settings are not rolled back. Pending futures confirmations are in memory and do not survive restart.

Account-wide daily realized loss and unrelated account exposure are not available from the current accounting implementation. Guard Mode enforces aggregate Spot and hedge ceilings across active Guard symbols. Direct Spot orders retain per-order and balance checks, while discretionary live entries are paused.

## Protective exits

The monitor evaluates already approved long-position mandates. It never waits for paid explanatory research before executing a protective exit. Concurrent timer/manual sweeps share one in-flight sweep per store. Exit request identifiers derive from mandate progress; quote high-water changes do not by themselves generate a new retry identity.

Only a fully filled result advances a mandate. Partial or unresolved fills halt for reconciliation. The journal keeps the reported exchange result and rule that fired. A stop is not a guaranteed exit price or a promise of breakeven.

## Persistence and hosting

SQLite stores research, decisions, proposals, confirmations, Guard operations, monitor checkpoints, mandates and research-payment bookkeeping. Additive schema migration preserves existing tables. The daemon and public MCP service keep separate named volumes.

Active mandates or unresolved operations prevent idle HTTP tenant eviction. Token-bearing HTTP runtime credentials are not persisted across restart. A dedicated daemon is the supported way to maintain monitoring continuity. Restarting a service is not proof that every external position is protected; inspect state and reconcile external orders.

## Independent verification

The public browser bundle is generated from core attestation code by scripts/build-verifier.mjs. The browser recovers the EIP-191 signature locally. Neither the public MCP endpoint nor an account is involved in that calculation.

A valid signature authenticates displayed signed fields relative to the claimed address. It does not establish personhood, settlement, provider-origin authenticity, accurate content, order fills or chronology. A payment block time does not independently timestamp an off-chain decision. These checks are displayed separately as NOT VERIFIED.

The public homepage demo reads a current public Binance market snapshot and asks the configured model for a constrained verdict. It has no account, payment, or order capability. `scripts/prove.ts` separately generates the offline verifier fixture with a fixed clock, recorded responses, a public test key and stored `NO_TRADE` decisions.
