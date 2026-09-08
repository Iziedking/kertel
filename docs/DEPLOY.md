# Running Telt on a server

Telt on a laptop only manages positions while the laptop is on. A stdio MCP
server is a child process of the client, so closing Claude Code closes the
monitor with it. On a server you run the daemon instead, and it keeps acting
while you sleep.

Two processes, one database:

| Process | What it is for | Where it runs |
| --- | --- | --- |
| `telt-daemon` | Watches positions, fires exits, settles verdicts | The server, always |
| `telt-mcp` | How you talk to Telt from Claude Code | Your machine, when you want it |

They share the SQLite file through WAL mode. The daemon does the acting; the
MCP server does the asking.

## The .env a server needs

Everything below goes in a `.env` file next to `docker-compose.yml`. It is never
baked into the image and never committed.

```bash
# --- Mode. Both of these, or nothing is placed. -----------------------------
TELT_MODE=live
TELT_LIVE_EXECUTION=true

# --- Where state lives. Must be the mounted volume. -------------------------
# Losing this loses every armed plan, every high-water mark, and the record of
# what has already been sold. The compose file mounts a named volume at /data.
TELT_DATA_DIR=/data
TELT_LOG_LEVEL=info

# --- Owner. --------------------------------------------------------------
# Telt refuses every command without one. E.164.
TELT_OWNER_WHATSAPP=+2348067053854

# --- Execution: Binance Agent OS. ------------------------------------------
# A bearer token with a thirty-day life and no refresh grant. Orders placed
# with it land in the Agentic sub-account, which has no withdrawal scope to
# grant at all.
#
# To get it: connect the MCP server to any supported client, complete the
# browser sign-in once, and copy the token the client stored.
#
#   claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
#
# In Claude Code it lands in ~/.claude/.credentials.json under mcpOAuth.
TELT_BINANCE_MCP_TOKEN=

# --- Execution fallback: a Binance API key. --------------------------------
# Optional. Used only when the Agent OS token is absent or has lapsed, so a
# server whose token expired can still manage open positions.
# Create it with Reading and Spot Trading on and WITHDRAWALS OFF.
TELT_BINANCE_API_KEY=
TELT_BINANCE_API_SECRET=

# --- Research payments over x402. ------------------------------------------
# A separate EVM key. Telt refuses to start if this equals the exchange key:
# the research wallet spends cents, the exchange key moves the trading balance,
# and one leak must not be both.
#
# Fund the same address with a few dollars of USDC on Base, or U on BNB Smart
# Chain to route through Binance's own B402 rail. Payments are gasless.
TELT_X402_PRIVATE_KEY=
TELT_X402_RAIL=auto
TELT_X402_MAX_PER_CALL_USDC=0.06
TELT_X402_MAX_PER_RUN_USDC=0.10
TELT_X402_MAX_PER_DAY_USDC=2.00

# --- Trading limits. -------------------------------------------------------
TELT_ALLOWED_SYMBOLS=ETHUSDT,BTCUSDT
TELT_MAX_TRADE_NOTIONAL=25
TELT_MAX_DAILY_LOSS=50
TELT_MAX_SLIPPAGE_BPS=50
TELT_PROPOSAL_TTL_SECONDS=120
```

An unset variable disables its own feature and says so in `telt_status`. A
variable that is set but malformed is a startup error naming the variable,
because an operator who typed `TELT_MAX_TRADE_NOTIONAL=fifty` believes a limit
is in force that is not.

## Deploy

```bash
git clone https://github.com/Iziedking/telt.git
cd telt

cp .env.example .env
$EDITOR .env                 # fill in the values above

docker compose up -d --build
docker compose logs -f
```

The first lines tell you whether it will actually trade:

```json
{"msg":"telt daemon starting","mode":"live","executionRail":"agent-os","liveExecution":true}
{"msg":"monitor started","intervalMs":30000}
```

If it says `"mode":"fixture"` or `"executionRail":"none"`, it will journal what
it *would* have done and place nothing. The `degraded` array on that same line
names the missing piece.

Every fifteen minutes it logs proof of life:

```json
{"msg":"alive","managing":1,"symbols":["ETHUSDT"],"killSwitch":false}
```

Without that, a wedged daemon and a quiet market look identical in a log, and
the first you hear of it is a stop that never fired.

## Talking to it from your machine

The daemon has no port and accepts no input. To ask it things, point a local MCP
server at the same database. The simplest arrangement is to keep the daemon on
the server and run the MCP server locally against a copy of the state carried
over with `telt_snapshot` and `telt_restore`.

If you want one database serving both, put the MCP server on the same host and
reach it over SSH:

```bash
claude mcp add telt-remote -- ssh user@your-vps \
  "TELT_DATA_DIR=/var/lib/telt node /opt/telt/apps/telt/dist/mcp.js"
```

That works because stdio is just a pipe, and SSH is a pipe. Both processes then
share one SQLite file in WAL mode.

## When the token expires

Thirty days, and Binance advertises no refresh grant. When it lapses the daemon
refuses with `EXECUTION_ADAPTER_UNAVAILABLE` naming the expiry rather than
failing obscurely. Sign in again, copy the new token, and restart:

```bash
$EDITOR .env
docker compose up -d
```

Positions survive: they are in the volume, not the container.

## Backups

The volume is the whole of Telt's memory of what it is managing.

```bash
docker compose exec telt node -e "process.stdout.write('')"   # ensure it is up
docker run --rm -v telt_telt-state:/data -v "$PWD:/out" \
  busybox tar czf /out/telt-state-$(date +%F).tar.gz -C /data .
```

Or take a `telt_snapshot` from the MCP server and store it in your memory
service, which is portable across machines rather than tied to this one.

## What this does not do

The daemon exposes no network service. It cannot be reached from a phone, a
browser, or another machine, and it holds no port open. Talking to Telt needs
the MCP server, which is stdio only.

Remote access over HTTP with its own authentication is not built. Until it is,
"trade from my phone" means Claude Code on a machine that can reach the same
database, not a public endpoint.
