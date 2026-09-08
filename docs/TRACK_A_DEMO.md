# Track A demo

The judge should remember one behavior: Telt keeps a Binance Spot hedge aligned after the trader stops watching it.

## Three-minute recording

### 0:00 to 0:20

Open [telt.site](https://telt.site) and state the problem:

> A hedge goes stale when the Spot holding changes. Telt lets me approve the protection boundary once, then watches both legs and fixes the drift through Binance Agent OS.

Show the public market demo for a few seconds. State that it has no account access. Move to the local MCP conversation and Binance account view.

### 0:20 to 0:45

Ask:

```text
Guard my SOL at 100% coverage and 2x for the next 24 hours.
```

Read the coverage, margin multiple, notional ceiling, and expiry. Approve the `telt_guard_arm` call once. Telt should classify the funded Spot holding as unprotected.

### 0:45 to 1:05

Ask:

```text
Check my protection now.
```

Show the isolated SOLUSDT Futures short appear in Binance. Match the exchange order reference with Telt's response. Ask for Guard status and show `PROTECTED`.

### 1:05 to 2:10

Change the SOL Spot quantity with a small, confirmed Spot order. Show that the existing Futures short no longer covers the new balance. After the 60 second Guard cooldown, ask Telt to check protection again.

Telt should classify the position as underhedged, submit the bounded increase, verify the final short quantity, and report the new state.

### 2:10 to 2:40

Ask:

```text
Show my SOL Memory Lane.
```

Point to the mandate, first classification, initial hedge, drift classification, adjustment, and exchange references. Explain that paid research is optional context and cannot authorize or block the hedge.

### 2:40 to 3:00

Ask:

```text
Revoke SOL Guard Mode and check it again.
```

Show that the mandate is revoked and no future adjustment is permitted. State that revocation leaves the current exchange position untouched so the trader can close it deliberately.

## Recording checks

- Keep the Binance Spot balance, Futures position, and MCP response visible together.
- Use the Agentic sub-account funded for the demo.
- Hide tokens, keys, environment files, confirmation codes from earlier runs, and personal account details.
- Use a quantity that clears Binance's Futures minimum position value and stays below every configured cap.
- Start with no conflicting Futures long and no cross-margin position on the demo symbol.
- Do not cut away during the first Guard adjustment. The live account change is the proof.
- End on Memory Lane and revocation, not on a market prediction.

## Claims to use

- Telt uses Binance Agent OS for account reads and Spot and Futures execution.
- One approved Guard mandate can open, increase, or reduce the permitted isolated short.
- The controller uses fixed rules and exchange filters. The model does not decide the hedge.
- Telt records an operation before sending it and verifies the final position.
- Unknown, partial, stale, cross-margin, and conflicting states stop the controller.

## Claims to avoid

- Do not claim guaranteed protection, profit, fill price, breakeven, or liquidation prevention.
- Do not call the current Guard portfolio cap full-account risk accounting. It covers active Guard symbols.
- Do not claim automatic recovery after an interrupted order. The current runtime halts for reconciliation.
- Do not claim paid research covers every Binance token.
- Do not claim a signed receipt proves payment settlement, provider origin, exchange execution, or chronology.
