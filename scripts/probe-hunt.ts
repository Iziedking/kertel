/**
 * The hunt loop, end to end, without the order.
 *
 * Everything runs for real: the budget gate, the venue scan, the candidate
 * choice, the paid research, and the model's verdict. Only the last step is
 * stopped — `TELT_LIVE_EXECUTION` is forced off, so if the loop decides to buy,
 * it reaches the write gate and stops there and says so.
 *
 * A temporary database is used, so an armed budget and any recorded verdicts do
 * not touch the real one.
 *
 * IT SPENDS REAL MONEY on research — about six cents for a full thesis. It
 * cannot place an order.
 *
 *   npx tsx scripts/probe-hunt.ts
 */

process.loadEnvFile?.(".env");

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before loadConfig reads it. This is the line that makes the probe safe.
process.env["TELT_LIVE_EXECUTION"] = "false";

import * as fp from "../packages/core/src/money/index.js";
import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createRuntime } from "../apps/telt/src/runtime.js";
import type { Instant } from "../packages/core/src/domain/index.js";

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "telt-hunt-"));
  process.env["TELT_DATA_DIR"] = dataDir;

  const runtime = createRuntime({ config: loadConfig(process.env) });

  try {
    console.log("=== 1. with no budget armed, it must refuse ===");
    console.log((await runtime.hunt()).body);

    console.log("\n=== 2. arm a budget ===");
    console.log(runtime.autonomy.arm({ granted: "10.00", perTrade: "4.00", hours: 24 }));

    console.log("\n=== 3. hunt (real scan, real paid research, real verdict) ===");
    const started = Date.now();
    const outcome = await runtime.hunt();
    console.log(`took ${String(Math.round((Date.now() - started) / 1000))}s\n`);
    console.log(outcome.body);
    console.log(`\nacted: ${String(outcome.acted)}`);

    console.log("\n=== 4. what it recorded, including what it passed on ===");
    for (const verdict of runtime.store.autonomy.recentVerdicts(5)) {
      console.log(
        `  ${verdict.symbol.padEnd(12)} ${verdict.action.padEnd(22)} ` +
          `conf ${String(Math.round(verdict.confidence)).padStart(3)}  acted=${String(verdict.acted)}`,
      );
      console.log(`     ${verdict.because.slice(0, 160)}`);
    }

    console.log("\n=== 5. budget afterwards ===");
    console.log(runtime.autonomy.status());
  } finally {
    runtime.close();
    // Best effort: on Windows the database may still be settling.
    setTimeout(() => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        console.log(`(temp database left at ${dataDir})`);
      }
    }, 500);
  }
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
