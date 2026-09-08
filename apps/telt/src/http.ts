/**
 * Telt as a public MCP server, so anyone can point a client at it.
 *
 * The stdio server is one process per user, launched by their own client, on
 * their own machine. That is the right shape for someone running their own
 * agent and the wrong shape for everything else: a phone cannot launch it, a
 * teammate cannot reach it, and nobody can check a proof of research without
 * first installing the thing that produced it.
 *
 * So this is the same runtime over HTTP, and the whole design question is what
 * a stranger is allowed to do with it. The answer here has three tiers, and the
 * reasoning behind each matters more than the code:
 *
 * - **Anyone, with no credentials: verify and read.** `telt_verify` is the
 *   important one. A proof only means something if the person doubting it can
 *   check it without trusting — or installing — anything of the doubter's own.
 *   Market reads come free too, because they cost nothing and reveal nothing.
 * - **With your own Agent OS token: your own account.** The token arrives per
 *   request and is never stored on disk. Each one gets its own database, keyed
 *   by a hash of the token rather than the token, so two users can never see
 *   each other's positions and the filenames leak nothing if the disk is read.
 * - **Nobody gets the operator's wallet.** Paid research spends real money from
 *   the key in this server's environment. Letting an anonymous caller spend it
 *   would be an open invitation to drain it, so callers who bring their own
 *   token get every capability except that one, and are told why rather than
 *   left wondering.
 *
 * Session state is deliberately absent — the transport is constructed without
 * a session id generator — so each request stands alone and the server can be
 * restarted or moved without anybody's client noticing.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./mcp.js";
import { loadConfig } from "./infra/config.js";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { createLogger } from "./infra/logger.js";
import type { Logger } from "./infra/logger.js";

/** The header a caller uses to bring their own Binance Agent OS token. */
export const TOKEN_HEADER = "x-telt-binance-token";

/** Bodies larger than this are refused unread. An MCP request is never big. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * How long an idle per-caller runtime is kept.
 *
 * Long enough that a conversation does not pay to reopen a database between
 * every message; short enough that a server serving many people does not hold
 * every one of their databases open for ever.
 */
const RUNTIME_IDLE_MS = 30 * 60 * 1000;

type Tenant = {
  readonly runtime: Runtime;
  lastUsed: number;
};

export type HttpServerOptions = {
  readonly port: number;
  /** Where per-caller databases live. Must be a mounted volume in a container. */
  readonly dataDir: string;
  readonly log?: Logger;
};

/**
 * A caller's identity, derived from their token and never equal to it.
 *
 * The token is a bearer credential for somebody's exchange account, so it must
 * not become a filename, a log line, or a map key that could be dumped. A hash
 * is a stable handle with none of those properties.
 */
function tenantKey(token: string): string {
  return createHash("sha256").update(`telt.tenant.v1\n${token}`).digest("hex").slice(0, 32);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating, but let the request finish arriving so the reply
        // can be written and read. Destroying the socket here would reach the
        // caller as a connection reset — indistinguishable from the server
        // having fallen over, which is a worse answer than "too large".
        refused = true;
        chunks.length = 0;
        reject(new Error("request body too large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (refused) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body was not JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

export function createHttpServer(options: HttpServerOptions): Server {
  const log = options.log ?? createLogger({ level: "info" }).child({ component: "telt-http" });
  const tenants = new Map<string, Tenant>();

  mkdirSync(options.dataDir, { recursive: true });

  /**
   * The runtime for this caller.
   *
   * Anonymous callers share one, because everything they can reach is either
   * stateless or public. A caller with a token gets their own, with their own
   * database — the isolation that makes a shared server safe to offer.
   */
  function runtimeFor(token: string | null): Runtime {
    const key = token === null ? "anonymous" : tenantKey(token);

    const existing = tenants.get(key);
    if (existing !== undefined) {
      existing.lastUsed = Date.now();
      return existing.runtime;
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      TELT_DATA_DIR: join(options.dataDir, key),
      // Never the operator's. An anonymous caller gets no exchange credentials
      // at all, and every trading tool then refuses with a reason.
      TELT_BINANCE_MCP_TOKEN: token ?? "",
      TELT_BINANCE_API_KEY: "",
      TELT_BINANCE_API_SECRET: "",
      // Paid research spends the operator's own money. A public endpoint that
      // let callers spend it would be drained within the hour.
      TELT_X402_PRIVATE_KEY: "",
    };

    const runtime = createRuntime({ config: loadConfig(env) });
    tenants.set(key, { runtime, lastUsed: Date.now() });
    log.info("tenant opened", { tenant: key, credentialed: token !== null });
    return runtime;
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - RUNTIME_IDLE_MS;
    for (const [key, tenant] of tenants) {
      if (tenant.lastUsed < cutoff && key !== "anonymous" && tenant.runtime.store.mandates.active().length === 0 && tenant.runtime.store.safetyState().unreconciledOperations.length === 0) {
        tenant.runtime.close();
        tenants.delete(key);
        log.info("tenant closed", { tenant: key, reason: "idle" });
      }
    }
  }, 60_000);
  sweep.unref();

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");

      // Any origin, deliberately.
      //
      // Verification has to work from a page the verifier trusts, which is not
      // necessarily one of ours — a proof only checkable on the prover's own
      // website is worth very little. Allowing this is safe here because
      // authentication is a custom header and never a cookie: a browser will
      // not attach a token to a cross-origin request on its own, so there is no
      // ambient authority for a hostile page to borrow.
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", `content-type, accept, ${TOKEN_HEADER}, mcp-session-id, mcp-protocol-version`);
      response.setHeader("access-control-allow-methods", "POST, OPTIONS");
      response.setHeader("access-control-expose-headers", "mcp-session-id");
      response.setHeader("access-control-max-age", "86400");

      if (request.method === "OPTIONS") {
        // The preflight every non-trivial POST triggers. Answered before any
        // routing, so a client learns it may proceed without a round trip into
        // the runtime.
        response.writeHead(204);
        response.end();
        return;
      }

      // A liveness check that says nothing about anybody's account.
      if (url.pathname === "/health") {
        send(response, 200, { ok: true, tenants: tenants.size });
        return;
      }

      if (url.pathname !== "/mcp") {
        send(response, 404, { error: "Not found. The MCP endpoint is /mcp." });
        return;
      }

      if (request.method !== "POST") {
        // Stateless mode answers no GET stream and holds no session to delete.
        send(response, 405, {
          error: "This server is stateless. Send JSON-RPC over POST /mcp.",
        });
        return;
      }

      const header = request.headers[TOKEN_HEADER];
      const raw = Array.isArray(header) ? header[0] : header;
      const token = raw === undefined || raw.trim() === "" ? null : raw.trim();

      let body: unknown;
      try {
        body = await readBody(request);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "bad request";
        send(response, message.includes("too large") ? 413 : 400, { error: message });
        return;
      }

      let transport: StreamableHTTPServerTransport | null = null;
      try {
        const runtime = runtimeFor(token);
        // Omitting `sessionIdGenerator` is what selects stateless mode. Each
        // request stands alone, so the server can restart or move hosts
        // without any client noticing.
        transport = new StreamableHTTPServerTransport({});
        const mcp = buildServer(runtime);
        await mcp.connect(transport as never);
        await transport.handleRequest(request, response, body);
      } catch (cause) {
        // Never the message: an exception from deep in a client can carry a
        // token or an account detail, and this reply is public.
        log.error("request failed", { problem: cause instanceof Error ? cause.name : "unknown" });
        if (!response.headersSent) {
          send(response, 500, { error: "Telt could not handle that request." });
        }
      } finally {
        // The transport is per request in stateless mode; the runtime it spoke
        // to is not, and must outlive it.
        void transport?.close();
      }
    })();
  });

  // Closing the server closes the databases it opened. Without this a caller
  // of `close()` gets a resolved promise and a directory full of locked files,
  // which on Windows means the next start cannot even read them.
  server.on("close", () => {
    clearInterval(sweep);
    for (const [key, tenant] of tenants) {
      tenant.runtime.close();
      tenants.delete(key);
    }
  });

  server.listen(options.port, () => {
    log.info("telt http server listening", { port: options.port, endpoint: "/mcp" });
  });

  return server;
}
