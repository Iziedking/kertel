/**
 * The OpenClaw plugin entry point.
 *
 * OpenClaw 2026.3.13 has no outbound MCP client — there is no `openclaw mcp`
 * command and no `mcpServers` registration for agent tools — so the plugin SDK
 * is the only seam for custom agent capability. Telt therefore ships as a
 * plugin and stays an MCP *client* to Binance Agent OS rather than a server.
 *
 * Two rules apply to everything registered below.
 *
 * **Every tool is `optional: true`.** Optional tools are never auto-enabled; an
 * operator has to name them in `agents.list[].tools.allow`. A plugin that
 * silently grants an agent the ability to spend money the moment it is
 * installed is not a plugin anyone should install.
 *
 * **Every tool is `ownerOnly: true`.** That is the host's own sender
 * restriction, and Telt checks the sender again itself. The channel allowlist
 * is a routing convenience, not a security boundary, and neither check is
 * trusted to be the only one.
 *
 * Tool names are all prefixed `telt_`, because a name that clashes with a
 * core tool is skipped *silently* — the failure mode is a tool that appears to
 * be installed and simply never runs.
 */

import { loadConfig, ConfigError } from "./infra/config.js";
import { createLogger } from "./infra/logger.js";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { researchTool } from "./tools/research.js";
import { statusTool } from "./tools/status.js";
import {
  cancelTool,
  confirmTool,
  proposeTool,
  reconcileTool,
  resumeTool,
  stopTool,
} from "./tools/trade.js";
import type { PluginApi } from "./tools/types.js";

export default function teltPlugin(api: PluginApi): void {
  let runtime: Runtime;

  try {
    const config = loadConfig(process.env);
    runtime = createRuntime({ config });
  } catch (cause) {
    // A configuration mistake must be loud and must name the variable, but it
    // must not take the gateway down: OpenClaw is running other channels and
    // other agents, and a misspelled Telt variable is not their problem.
    // Telt registers nothing, and the operator sees exactly what to fix.
    const log = createLogger({ level: "error" }).child({ component: "telt" });
    const message = cause instanceof ConfigError ? cause.message : String(cause);
    log.error("telt did not start; no tools were registered", { problem: message });
    return;
  }

  const tools = [
    statusTool(runtime),
    researchTool(runtime),
    proposeTool(runtime),
    confirmTool(runtime),
    cancelTool(runtime),
    reconcileTool(runtime),
    stopTool(runtime),
    resumeTool(runtime),
  ];

  for (const tool of tools) {
    api.registerTool(tool, { optional: true });
  }

  runtime.log.info("telt tools registered", {
    tools: tools.map((tool) => tool.name),
    mode: runtime.mode,
    liveExecution: runtime.config.policy.trading.liveExecutionEnabled,
  });
}

export { createRuntime } from "./runtime.js";
export { loadConfig, ConfigError } from "./infra/config.js";
export type { TeltConfig } from "./infra/config.js";
export type { Runtime } from "./runtime.js";
