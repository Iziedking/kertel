/**
 * The OpenClaw tool surface, declared locally.
 *
 * These mirror `AnyAgentTool` from `openclaw/dist/plugin-sdk/agents/tools/common.d.ts`
 * and `AgentTool` from `@mariozechner/pi-agent-core@0.58.0`, read from the
 * installed 2026.3.13 release on 2026-09-07.
 *
 * Declared here rather than imported so this package builds and tests without
 * the global OpenClaw install present. The cost is that a change in the host's
 * signature shows up as a runtime mismatch instead of a compile error, so the
 * shape is written out in full above rather than loosely typed, and the version
 * it was read from is recorded.
 *
 * Parameter schemas are TypeBox (`@sinclair/typebox`), not zod. zod is the
 * validator for provider payloads and configuration; TypeBox is only the tool
 * signature at the OpenClaw boundary.
 */

import type { TSchema } from "@sinclair/typebox";

export type AgentToolResult = {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
};

export type AgentTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  /**
   * Real sender restriction from the host, on top of Kertel's own owner check.
   *
   * Defence in depth: the host allowlist is a routing convenience and Kertel
   * verifies the sender itself as well. Neither is trusted to be the only one.
   */
  readonly ownerOnly?: boolean;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
};

export type RegisterOptions = {
  /**
   * Optional tools are never auto-enabled; an operator must name them in
   * `agents.list[].tools.allow`. Everything Kertel registers that spends money
   * or places an order ships optional.
   */
  readonly optional?: boolean;
};

export type PluginApi = {
  registerTool(tool: AgentTool, options?: RegisterOptions): void;
};

export function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: "text", text }], isError };
}
