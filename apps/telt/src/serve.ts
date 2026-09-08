#!/usr/bin/env node
/**
 * The public Telt server.
 *
 * Runs the MCP endpoint over HTTP and, in the same process, the monitor that
 * manages positions while nobody is watching. Both, because a hosted agent
 * that only acts while someone is talking to it is not an agent — it is a
 * command line with extra steps.
 *
 *   TELT_HTTP_PORT=8787 node apps/telt/dist/serve.js
 *
 * Put a TLS terminator in front of it. This speaks plain HTTP on purpose:
 * whatever is already handling certificates for the domain does that job
 * better than a process that also holds trading credentials.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createHttpServer } from "./http.js";
import { createLogger } from "./infra/logger.js";

function loadDotEnv(): void {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // A malformed .env is the operator's to fix. Starting up pretending it
      // was empty would hide the mistake behind a server with no limits.
    }
  }
}

loadDotEnv();

const port = Number(process.env["TELT_HTTP_PORT"] ?? "8787");
const dataDir = process.env["TELT_TENANT_DIR"] ?? "./data/tenants";

const log = createLogger({ level: "info" }).child({ component: "telt-serve" });

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log.error("TELT_HTTP_PORT is not a usable port", { value: process.env["TELT_HTTP_PORT"] });
  process.exitCode = 1;
} else {
  const server = createHttpServer({ port, dataDir, log });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
