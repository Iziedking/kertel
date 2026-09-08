/**
 * The daemon has to stay running.
 *
 * That sounds too obvious to test until you have watched it not do so. Every
 * timer in Telt is `unref`'d, because a pending monitor tick must not hold the
 * MCP server open after its client has gone. The daemon has no client, no stdin
 * and no socket — so with every timer unref'd it reached the end of `main`,
 * exited 0, was restarted by Docker, logged a perfectly healthy startup, and
 * did the whole thing again a few seconds later. For ever.
 *
 * Nothing on a development machine reproduces it, because there the monitor
 * always runs inside the stdio server, which stdin keeps alive. It took a
 * deploy to find, so it gets a test that would have found it instead.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Built output, which is what actually ships and therefore what to test. */
const DAEMON = fileURLToPath(new URL("../dist/daemon.js", import.meta.url));

let child: ChildProcess | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  // Wait for the process to actually go before touching its files. A kill
  // returns immediately, and on Windows the database stays locked until the
  // process has really exited — so removing the directory races it.
  if (child !== null && child.exitCode === null) {
    const stopped = new Promise((resolve) => child?.once("exit", resolve));
    child.kill("SIGKILL");
    await stopped;
  }
  child = null;
  if (dataDir !== null) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

describe("the daemon process", () => {
  it("is still alive after the monitor has started", async () => {
    // Skipped rather than failed when the build has not been run: a missing
    // dist is a stale checkout, not a broken daemon.
    if (!existsSync(DAEMON)) {
      expect(existsSync(DAEMON)).toBe(false);
      return;
    }

    dataDir = mkdtempSync(join(tmpdir(), "telt-daemon-"));

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        TELT_DATA_DIR: dataDir,
        // No credentials on purpose. A daemon with nothing to do must still
        // stay up and say so — exiting would look identical to a crash to
        // whatever is supervising it.
        TELT_BINANCE_MCP_TOKEN: "",
        TELT_BINANCE_API_KEY: "",
        TELT_BINANCE_API_SECRET: "",
        TELT_X402_PRIVATE_KEY: "",
        TELT_MODE: "fixture",
        TELT_LIVE_EXECUTION: "false",
        TELT_LOG_LEVEL: "silent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let exited: number | null = null;
    child.on("exit", (code) => {
      exited = code ?? -1;
    });

    // Long enough to be past startup and any first sweep, short enough not to
    // slow the suite down noticeably.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    expect(exited).toBeNull();
    expect(child.killed).toBe(false);
  }, 15_000);
});
