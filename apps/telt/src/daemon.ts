#!/usr/bin/env node
/**
 * Telt with nobody watching.
 *
 * The MCP server only runs while a client holds it open: a stdio server is a
 * child process, and when Claude Code exits, so does the monitor. That is fine
 * on a laptop and useless on a server, where the whole point is that positions
 * are managed while you are asleep.
 *
 * So this is the same runtime with no protocol attached. It loads the config,
 * opens the same database, starts the monitor, and stays up. Nothing else. It
 * exposes no port and accepts no input, which means the only way to influence
 * it is to change what is in its database or its environment.
 *
 * Run it alongside the MCP server, not instead of it. They share the SQLite
 * file: the MCP server is how you talk to Telt, the daemon is what keeps
 * acting when you close the laptop. SQLite in WAL mode handles both processes.
 *
 * One thing to get right in a container: `TELT_DATA_DIR` must point at a
 * mounted volume. A database inside the image is lost on the next deploy, and
 * losing it means losing every armed plan, every high-water mark, and the
 * record of what has already been sold.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "./infra/config.js";
import { createLogger } from "./infra/logger.js";
import { createRuntime } from "./runtime.js";

/** Long enough that a restart loop is obvious in the logs, short enough to matter. */
const HEARTBEAT_MS = 15 * 60 * 1000;

function loadDotEnv(): string | null {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(envPath)) {
    return null;
  }
  try {
    process.loadEnvFile(envPath);
    return envPath;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const envPath = loadDotEnv();
  const log = createLogger({
    level: "info",
    write: (line) => process.stdout.write(`${line}\n`),
  }).child({ component: "telt-daemon" });

  let runtime;
  try {
    runtime = createRuntime({ config: loadConfig(process.env) });
  } catch (cause) {
    const message = cause instanceof ConfigError ? cause.message : String(cause);
    log.error("telt could not start", { problem: message });
    process.exitCode = 1;
    return;
  }

  // Say plainly what this process will and will not do. A daemon that starts
  // silently in fixture mode looks identical to one that is trading, and the
  // operator finds out days later that nothing happened.
  log.info("telt daemon starting", {
    mode: runtime.mode,
    executionRail: runtime.executionRail,
    liveExecution: runtime.config.policy.trading.liveExecutionEnabled,
    dataDir: runtime.config.dataDir,
    envFile: envPath,
    degraded: runtime.config.degraded,
  });

  if (runtime.mode !== "live" || !runtime.config.policy.trading.liveExecutionEnabled) {
    log.warn("no order will be placed", {
      why: "TELT_MODE must be live and TELT_LIVE_EXECUTION must be true. The monitor will still run and journal what it would have done.",
    });
  }

  const safety = runtime.store.safetyState();
  if (safety.killSwitchEngaged) {
    log.warn("starting with the kill switch engaged", { reason: safety.killSwitchReason });
  }

  runtime.monitor.start();

  // Proof of life. Without it a wedged daemon and a quiet market look the same
  // in a log, and the first you know of it is a stop that never fired.
  const heartbeat = setInterval(() => {
    const positions = runtime.store.mandates.active();
    log.info("alive", {
      managing: positions.length,
      symbols: positions.map((mandate) => mandate.symbol),
      killSwitch: runtime.store.safetyState().killSwitchEngaged,
    });
  }, HEARTBEAT_MS);
  // Deliberately NOT unref'd, unlike every other timer in Telt.
  //
  // The monitor's own interval is unref'd so that a pending tick cannot hold
  // the MCP server open after its client goes away. That is right there, and
  // fatal here: the daemon has no stdin, no socket and no client — this timer
  // is the only thing keeping its event loop alive. Unref it and the process
  // reaches the end of main, exits 0, gets restarted by Docker, and does it
  // again a few seconds later for ever, logging a healthy startup every time.
  //
  // Found by deploying it. Nothing on a laptop reproduces it, because there
  // the monitor always runs inside the stdio server.

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    log.info("stopping", { signal });
    clearInterval(heartbeat);
    runtime.monitor.stop();
    // Close the database rather than letting the process die mid-write: an
    // interrupted WAL checkpoint is recoverable, but there is no reason to
    // find out how recoverable on a machine holding live positions.
    runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });

  // A crash in a sweep is already caught inside the monitor. Anything reaching
  // here is a defect, and dying loudly beats carrying on in an unknown state
  // while a supervisor believes the process is healthy.
  process.on("uncaughtException", (cause) => {
    log.error("unhandled error, stopping", { cause });
    runtime.monitor.stop();
    runtime.close();
    process.exit(1);
  });
  process.on("unhandledRejection", (cause) => {
    log.error("unhandled rejection, stopping", { cause });
    runtime.monitor.stop();
    runtime.close();
    process.exit(1);
  });
}

void main();
