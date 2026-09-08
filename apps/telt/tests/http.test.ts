/**
 * What a stranger can and cannot do with a public Telt.
 *
 * A hosted agent that holds trading credentials is a thing people will point
 * unpleasant requests at, so these tests are mostly about boundaries: what an
 * anonymous caller reaches, what two callers must never share, and what must
 * never appear on disk.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createHttpServer, TOKEN_HEADER } from "../src/http.js";
import { createLogger } from "../src/infra/logger.js";

let server: Server;
let base: string;
let dataDir: string;

/** A token-shaped string. It reaches no exchange; it only has to be distinct. */
const ALPHA = "alpha-token-0000000000000000";
const BETA = "beta-token-1111111111111111";

async function rpc(
  method: string,
  params: unknown,
  token?: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { [TOKEN_HEADER]: token }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  // Stateless streamable HTTP answers as SSE; one message is all we send.
  const text = await response.text();
  for (const line of text.split("\n")) {
    const trimmed = line.startsWith("data: ") ? line.slice(6) : line;
    if (trimmed.trim() === "" || trimmed.startsWith("event:")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

async function callTool(name: string, args: unknown, token?: string): Promise<string> {
  await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
    token,
  );
  const answer = await rpc("tools/call", { name, arguments: args }, token);
  const result = answer?.["result"] as { content?: { text?: string }[] } | undefined;
  return (result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "telt-http-"));
  server = createHttpServer({
    port: 0,
    dataDir,
    log: createLogger({ level: "silent" }),
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  // Closing must release every tenant database, or the cleanup below fails on
  // Windows with EBUSY — which is exactly what it did before the server
  // learned to close what it opened.
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("what anyone can do", () => {
  it("answers a liveness check without saying anything about accounts", async () => {
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body["ok"]).toBe(true);
    // A count, never a list. Who is connected is nobody else's business.
    expect(Object.keys(body)).toEqual(["ok", "tenants"]);
  });

  it("lets a caller with no credentials verify a proof", async () => {
    // The one that matters. A proof is worthless if checking it requires
    // installing the thing that produced it.
    const body = await callTool("telt_verify", {
      attestation: [
        "TELT-ATTESTATION-1",
        "symbol=ETHUSDT",
        "goal=price_check",
        "at=2026-09-08T02:52:01.134Z",
        "agent=0xd2f6393c6a916acb98057a5920952084b838cfd1",
        "provenance=8c07355f4d640a4f7654116add00fa63b89e2597fa41d958906870ee36436442",
        "spent=0.01",
        "decision=EVIDENCE_ONLY",
        "order=none",
        "payment=coingecko:base-usdc:0x8f6d21822954bc2d9606a6e4a7f9c9464e62647f1c73bfb2059b3a72b486b873:0.01",
        "sig=0x9941c368ddddfc8621fadb557b384d7913ac715c91c4049f11012c5795f8badf0139eb657e6d48a50c578d882484a30d75853d97ac0a682204d9b648b74577de1b",
      ].join("\n"),
    });

    expect(body).toContain("Attestation verified");
    expect(body).toContain("0xd2f6393c6a916acb98057a5920952084b838cfd1");
  });

  it("catches a forged proof from an anonymous caller too", async () => {
    const body = await callTool("telt_verify", { attestation: "TELT-ATTESTATION-1\nnonsense" });
    expect(body).toContain("not a Telt attestation");
  });
});

describe("what a stranger must not reach", () => {
  it("gives an anonymous caller no exchange credentials", async () => {
    // The operator's own token is in this process's environment. It must never
    // be what an anonymous caller trades with.
    const body = await callTool("telt_status", {});
    expect(body).toContain("Live order execution:");
    expect(body).not.toContain("ready via");
  });

  it("refuses anything that is not the MCP endpoint", async () => {
    const response = await fetch(`${base}/../etc/passwd`);
    expect(response.status).toBe(404);
  });

  it("refuses a GET, rather than holding a session open", async () => {
    const response = await fetch(`${base}/mcp`);
    expect(response.status).toBe(405);
  });

  it("refuses a body too large to be a real request", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2_000_000),
    });
    // 413, not a dropped connection: a caller must be able to tell "too large"
    // from "the server fell over".
    expect(response.status).toBe(413);
  });
});

describe("keeping callers apart", () => {
  it("gives two tokens two databases, and neither is named after a token", async () => {
    await callTool("telt_status", {}, ALPHA);
    await callTool("telt_status", {}, BETA);

    const dirs = readdirSync(dataDir);
    // Anonymous plus one each.
    expect(dirs.length).toBeGreaterThanOrEqual(3);

    // The token is a bearer credential for somebody's exchange account. It must
    // not become a filename, where a disk dump or a stray log would expose it.
    for (const dir of dirs) {
      expect(dir).not.toContain(ALPHA);
      expect(dir).not.toContain(BETA);
      expect(dir).not.toContain("token");
    }
  });
});
