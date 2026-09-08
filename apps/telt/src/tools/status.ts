/**
 * `telt_status` — the capability truth table, rendered.
 *
 * This is the tool that makes the rest of the product checkable. Anyone can
 * claim an agent trades on Binance and pays for research over x402; this prints
 * which of those are actually wired on *this* machine right now, and names the
 * missing piece for each one that is not.
 *
 * It is deliberately the least clever tool in the plugin: no network, no
 * payment, no model. It reads configuration and durable state and formats them.
 * A status tool that can fail for interesting reasons is useless precisely when
 * it is needed.
 */

import { Type } from "@sinclair/typebox";

import * as fp from "@telt/core/money";
import { formatInstant } from "@telt/core/domain";

import { railsFor } from "../infra/config.js";
import type { Runtime } from "../runtime.js";
import { textResult } from "./types.js";
import type { AgentTool } from "./types.js";

function tick(available: boolean): string {
  return available ? "ready" : "unavailable";
}

export function statusTool(runtime: Runtime): AgentTool {
  return {
    name: "telt_status",
    label: "Telt status",
    description:
      "Report what Telt can and cannot currently do: mode, owner, research wallet and payment rails, " +
      "spend against the daily cap, the kill switch, and any unresolved payments. Reads local state only. " +
      "Use this before claiming any Telt capability is available.",
    parameters: Type.Object({}, { additionalProperties: false }),
    ownerOnly: true,

    async execute() {
      const { config, store, clock, x402 } = runtime;
      const now = clock.now();
      const safety = store.safetyState();
      const spent = store.spentOn(now);
      const unresolved = store.unresolvedPayments();
      const rails = railsFor(config.railPreference);

      const lines: string[] = [];
      lines.push("Telt status");
      lines.push("");

      lines.push(`Mode: ${config.mode}`);
      if (config.mode === "fixture") {
        lines.push("  Saved data only. No payment is signed and no order is placed.");
      }
      lines.push(`Owner: ${config.ownerWhatsApp === null ? "not configured" : "configured"}`);
      lines.push("");

      lines.push("Capabilities");
      lines.push(`  Free venue price (Binance public):  ready`);
      lines.push(`  Paid research over x402:            ${tick(x402.walletConfigured)}`);
      lines.push(
        `  Live order execution:               ${tick(config.policy.trading.liveExecutionEnabled && config.mode === "live")}`,
      );
      lines.push(
        `  Execution rail:                     ${
          runtime.executionRail === "agent-os"
            ? "Binance Agent OS (Agentic sub-account, no withdrawal scope)"
            : runtime.executionRail === "api-key"
              ? "Binance REST with an API key"
              : "none configured"
        }`,
      );
      lines.push("");

      lines.push("Research payments");
      lines.push(`  Rail preference: ${config.railPreference} (${rails.map((rail) => rail.id).join(" then ")})`);
      lines.push(`  Payer address:   ${x402.payerAddress ?? "none"}`);
      lines.push(
        `  Spent today:     ${fp.format(fp.trim(spent, 2))} of ${fp.format(config.policy.x402.maxPerDayUsdc)} cap`,
      );
      lines.push(
        `  Per call / run:  ${fp.format(config.policy.x402.maxPerCallUsdc)} / ${fp.format(config.policy.x402.maxPerRunUsdc)}`,
      );
      lines.push("");

      lines.push("Trading limits");
      lines.push(`  Symbols:         ${config.policy.trading.allowedSymbols.join(", ")}`);
      lines.push(
        `  Max per trade:   ${fp.format(config.policy.trading.maxTradeNotional)} (exchange minimum is 5.00, so the usable window is narrow)`,
      );
      lines.push("  Daily loss / total exposure: unavailable, not enforced as account-wide caps");
      lines.push("  Discretionary live entries: paused until complete risk accounting is available");
      lines.push(`  Max slippage:    ${String(config.policy.trading.maxSlippageBps)} bps`);
      lines.push("");

      // Futures needs its own two lines because the spot ones do not bound it:
      // leverage means a small margin controls a large position.
      lines.push("Futures limits");
      if (runtime.futures === null) {
        lines.push("  Unavailable. Futures runs on the Agent OS rail only.");
      } else {
        lines.push(`  Max leverage:    ${String(config.maxLeverage)}x, isolated margin always`);
        lines.push(
          `  Max position:    ${fp.format(config.maxFuturesNotional)} (on the position, not the margin behind it)`,
        );
      }
      lines.push("");

      lines.push("Safety");
      if (safety.killSwitchEngaged) {
        lines.push(`  KILL SWITCH ENGAGED: ${safety.killSwitchReason ?? "no reason recorded"}`);
        if (safety.killSwitchEngagedAt !== null) {
          lines.push(`  Engaged at ${formatInstant(safety.killSwitchEngagedAt)}`);
        }
      } else {
        lines.push("  Kill switch: off");
      }
      if (unresolved.length > 0) {
        lines.push(`  ${String(unresolved.length)} payment(s) signed and never confirmed:`);
        for (const attempt of unresolved) {
          lines.push(`    ${attempt.provider} $${attempt.chargedUsdc} (${attempt.attemptId})`);
        }
        lines.push("  Reconcile these before resuming.");
      }

      if (config.degraded.length > 0) {
        lines.push("");
        lines.push("Not available, and why");
        for (const reason of config.degraded) {
          lines.push(`  - ${reason}`);
        }
      }

      lines.push("");
      lines.push(formatInstant(now));

      return textResult(lines.join("\n"));
    },
  };
}
