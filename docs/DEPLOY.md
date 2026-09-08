# Deploying Telt

Two things get deployed, to two places, for a reason.

**The agent** goes on your VPS. It holds credentials and manages positions, so
it needs a machine that stays up and a database that outlives every release.

**The site** goes on Vercel. It holds nothing, and putting a marketing page on
the same host as a trading key buys you nothing but a larger blast radius.

Neither deploy needs anyone to open a terminal after the first time.

---

## 1. DNS

Two records, doing different jobs.

| Name | Type | Value | Serves |
| --- | --- | --- | --- |
| `telt.site` | as Vercel instructs | Vercel | The site and the verifier |
| `mcp.telt.site` | `A` | `3.136.155.81` | The MCP endpoint |

That is the instance's **public** address. Its private one, `172.31.47.15`, is
inside the VPC and is not routable from the internet — pointing DNS at it
produces a name that resolves and never answers.

`mcp.telt.site` must resolve **before** the first deploy. Caddy asks Let's
Encrypt for a certificate on startup, and that fails if the name does not point
at the machine answering the challenge.

Check it before you go further:

```bash
dig +short mcp.telt.site      # must print 3.136.155.81
```

---

## 2. The VPS, once

Everything after this is automatic. Run these once, as a user in the `docker`
group.

```bash
# Docker, if it is not already there
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # log out and back in

# The repository
git clone https://github.com/Iziedking/kertel.git ~/telt
cd ~/telt

# Your secrets. Never committed, never in an image.
cp .env.example .env
$EDITOR .env
chmod 600 .env
```

Fill in `.env` from `.env.example`. The four that matter:

- `TELT_BINANCE_MCP_TOKEN` — your Agent OS token. Thirty days, then one browser
  sign-in to replace it.
- `TELT_X402_PRIVATE_KEY` — the research wallet. It holds a few dollars and it
  signs your proofs of research. **It must not be the same secret as anything
  that can move your trading balance**; Telt refuses to start if it is.
- `TELT_MODE=live` and `TELT_LIVE_EXECUTION=true` — both, or no order is sent.

Then:

```bash
docker compose up -d --build
docker compose ps
curl -fsS https://mcp.telt.site/health
```

`{"ok":true,"tenants":0}` means you are done.

### TLS: shared, not duplicated

This host already runs a Caddy, for `nock.lat`. Telt does **not** bring its own
— two containers cannot both bind 443, so a second one would simply fail to
start. Instead Telt joins that Caddy's network and adds one site block:

```bash
cat ~/telt/deploy/Caddyfile.snippet >> ~/nock/Caddyfile
docker exec nock-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

`reload` is graceful; nock.lat does not drop a connection. Do this **after**
DNS resolves, or Caddy will fail the certificate order noisily and against a
rate limit.

### What is actually running

```
telt-daemon    your agent. Your token, your positions, no open port at all.
telt-mcp       the public endpoint on 8790. NO credentials of yours, by design.
nock-caddy-1   already there. Now terminates TLS for mcp.telt.site too.
```

Port 8790 rather than 8787: nock's watcher already holds 8787 on this machine.
Ports are a property of the host, not of a project.

That split is a security boundary, not tidiness. `telt-mcp` is the container
strangers talk to, and it is configured with an empty exchange token and an
empty research wallet. Anonymous callers can verify proofs and read markets.
A caller who brings their own Agent OS token in `X-Telt-Binance-Token` gets
their own account and their own database, keyed by a hash of the token so the
filename leaks nothing. **If that container were breached tomorrow the attacker
would hold nothing worth having** — which is the only sentence that makes a
public trading endpoint defensible at all.

---

## 3. CI/CD

Push to `main` and the rest happens.

`.github/workflows/deploy.yml` runs the full suite first, builds the image to
catch a Dockerfile mistake in CI rather than halfway through production, then
SSHes in, pulls, rebuilds and waits for `/health` to answer before calling the
deploy green. A deploy that reports success while the container crash-loops is
worse than one that fails.

Add these under **Settings → Secrets and variables → Actions**:

| Secret | What it is |
| --- | --- |
| `VPS_HOST` | `3.136.155.81` |
| `VPS_USER` | `ubuntu` |
| `VPS_SSH_KEY` | A **private** key whose public half is in that user's `authorized_keys` |
| `VPS_PORT` | `22` |
| `VPS_APP_DIR` | `/home/ubuntu/telt` |

```bash
gh secret set VPS_HOST    --repo Iziedking/kertel --body "3.136.155.81"
gh secret set VPS_USER    --repo Iziedking/kertel --body "ubuntu"
gh secret set VPS_PORT    --repo Iziedking/kertel --body "22"
gh secret set VPS_APP_DIR --repo Iziedking/kertel --body "/home/ubuntu/telt"
gh secret set VPS_SSH_KEY --repo Iziedking/kertel < ~/.ssh/telt_deploy
```

Make a key for this and nothing else, so it can be revoked without disturbing
your own access:

```bash
ssh-keygen -t ed25519 -C "telt-deploy" -f ~/.ssh/telt_deploy -N ""
ssh-copy-id -i ~/.ssh/telt_deploy.pub <user>@<host>
cat ~/.ssh/telt_deploy        # this is VPS_SSH_KEY
```

The daemon is **replaced, not torn down**: `compose up -d` recreates only what
changed, and the named volume carries every armed plan, every high-water mark
and the record of what has already been sold across the release. Losing that
volume loses all of it, so `docker compose down -v` is the one command to be
careful with.

---

## 4. The site

Import the repository into Vercel and set the root directory to `web`. Every
push to `main` that touches `web/` redeploys it.

One environment variable, and only if your endpoint is not the default:

```
NEXT_PUBLIC_TELT_MCP=https://mcp.telt.site/mcp
```

The verifier calls that endpoint from the reader's browser — the same endpoint
anyone can point their own client at. It has no private route to the truth,
which is the point: a proof only checkable on the prover's own website is worth
very little.

---

## Operating it

```bash
docker compose logs -f telt-daemon      # what the agent is doing
docker compose logs -f telt-mcp         # who is calling the endpoint
docker compose restart telt-daemon      # after an .env change
docker compose down                     # stop; positions and volume survive
```

**When the Agent OS token expires** — thirty days, no refresh grant — the
daemon starts saying so rather than failing quietly. Sign in again, replace
`TELT_BINANCE_MCP_TOKEN` in `.env`, and `docker compose restart telt-daemon`.

**Back up the volume** before anything you are unsure about:

```bash
docker run --rm -v telt-state:/data -v "$PWD:/out" alpine \
  tar czf /out/telt-state-$(date +%F).tar.gz -C /data .
```

**If the endpoint stops answering**, the healthcheck restarts the container on
its own. If it keeps happening, `docker compose logs --tail 100 telt-mcp` will
say why, and the daemon is unaffected either way — they are separate processes
holding separate databases, which is most of the reason they are separate
containers.
