# Going live

Written for the operator, in the order the steps actually have to happen. Every
command here has been run on this machine; nothing below is from memory.

Current state: the plugin is built, registered with OpenClaw, and loads with all
eight tools. WhatsApp is linked and narrowed to one number. What is missing is
money and one credential.

---

## 1. Create the Binance API key (5 minutes)

Kertel trades through an ordinary Binance API key, **not** the Agent OS MCP
server. The MCP server authorises over OAuth with a browser redirect, and a
long-running gateway cannot re-run a browser flow or borrow another client's
credential.

In Binance → **API Management** → Create API:

| Permission | Set it to |
| --- | --- |
| Enable Reading | **YES** |
| Enable Spot & Margin Trading | **YES** |
| Enable Withdrawals | **NO** — leave off, always |
| Restrict access to trusted IPs | recommended if this host has a static IP |

With withdrawals off, the worst case of a total compromise of this key is bad
trades inside the account, not drained funds. That is the single most useful
sentence in the capability truth table, and it is only true if you leave the
box unticked.

Then put both halves in `.env`:

```
KERTEL_BINANCE_API_KEY=...
KERTEL_BINANCE_API_SECRET=...
```

Kertel refuses to start if only one is set, or if the key equals
`KERTEL_X402_PRIVATE_KEY` — the research wallet spends cents on data and the
exchange key can move the trading balance, so one leak must not be both.

---

## 2. Fund the two things Kertel spends

They are separate on purpose and have different blast radii.

**Research data** — one EVM address, funded on either chain:

- a few dollars of **USDC on Base** covers all four providers today;
- a few dollars of **U on BNB Smart Chain** additionally routes CoinMarketCap
  and Nansen over Binance's own B402 rail.

No gas token is needed on either chain: x402 payments are gasless for the payer.
A full trade thesis costs $0.06, so five dollars is roughly eighty of them.

**Trading** — the Binance Spot account the API key belongs to needs USDT. Note
that if you created the key under a **sub-account**, it starts empty and funds
must be moved there deliberately at
`https://www.binance.com/en/my/sub-account/asset-management/transfer`.

The tradeable window is narrow: Binance's own minimum is **5.00 USDT** and
`KERTEL_MAX_TRADE_NOTIONAL` is 25. Fund at least 30 USDT so a couple of orders
fit.

---

## 3. Rehearse before you arm it

Leave `KERTEL_MODE=fixture`. Message the bot from `+2348067053854`:

```
status
research ETHUSDT price check
propose buying 10 USDT of ETHUSDT
confirm KTL-XXXXXX
```

The confirm **will** be refused with `LIVE_EXECUTION_DISABLED`, and that is the
point: every other gate ran first — balance, exchange filters, notional
minimum, slippage, the confirmation code — and only the write gate stopped it.
The code is not consumed by a dry run, so you can repeat this as often as you
like.

Check the proposal message carefully. The quantity shown is the quantity that
will be sent, already rounded down to the exchange step size, and the line
about what was left unspent is real.

---

## 4. Arm it

```
KERTEL_MODE=live
KERTEL_LIVE_EXECUTION=true
```

Both. `KERTEL_MODE=live` alone still refuses; so does the flag alone. Anything
other than exactly `true` or `false` in `KERTEL_LIVE_EXECUTION` is a startup
error rather than a quiet "off", because somebody who wrote `yes` believes
trading is on.

Restart the gateway, then:

```
openclaw config validate
openclaw plugins list        # Kertel should say "loaded"
```

Message `status` and confirm it reads:

```
Live order execution:               ready
```

**Start with one small order.** The first live confirm is the first time the
whole path runs for real. Watch that the fill price in the receipt is close to
the price in the proposal.

---

## 5. When something goes wrong

| What you see | What to do |
| --- | --- |
| `EXECUTION_RESULT_UNKNOWN` | Kertel already stopped itself. Run `kertel_reconcile` — it asks the exchange what actually happened, using the client order id it chose before sending. Then `kertel_resume`. |
| `X402_PAYMENT_UNKNOWN` | A research payment was signed with no confirmation. Kertel stopped itself and charged the amount pessimistically. Check the payer address on the chain explorer, then reconcile. |
| Anything that looks wrong | `kertel_stop` with a reason. It survives a restart. |

`kertel_resume` refuses while anything is unreconciled. That is deliberate: the
kill switch engaged because Kertel lost track of money, and resuming without
finding it just resumes the uncertainty.

---

## What is still not wired

Stated plainly so nothing here is a surprise:

- **The model does not write a thesis yet.** `kertel_research` returns evidence
  and says there is no thesis, rather than inventing one.
- **Realised loss and open exposure are passed as zero** to the proposal gate.
  The daily-loss and exposure caps therefore do not bite yet. The per-trade cap
  and the balance check do.
- **Only market orders.** Limit orders are modelled throughout and not wired.
- **The Graph tier never runs**, because no subgraph has been chosen. The
  receipt says so rather than implying onchain evidence that was never fetched.
