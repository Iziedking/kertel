#!/usr/bin/env node
/**
 * Kertel as an MCP server.
 *
 * This is the primary surface. Binance's Agent OS is reached from Claude Code,
 * Claude, Codex, ChatGPT and VS Code, so that is where an agent built on it
 * belongs — the reasoning layer is the client's model, and Kertel is the thing
 * it reasons *with*.
 *
 * That split is the point. Kertel does not write the verdict and does not own
 * an LLM key. It gathers evidence deterministically, prices it, refuses what it
 * cannot justify, and hands back structured facts with a receipt showing what
 * was bought and what was deliberately skipped. The model reads that and forms
 * the view. A model cannot talk Kertel into an endpoint, a price, or an order
 * size, because none of those are model inputs.
 *
 * **stdout belongs to the protocol.** The stdio transport frames JSON-RPC on
 * stdout, so a single stray `console.log` corrupts the stream and the client
 * disconnects with no useful error. Every log line here goes to stderr, which
 * is where MCP clients collect diagnostics anyway.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ConfigError, loadConfig } from "./infra/config.js";
import { createLogger } from "./infra/logger.js";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";

const VERSION = "0.1.0";

type TextResult = {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
};

function text(body: string, isError = false): TextResult {
  return { content: [{ type: "text", text: body }], isError };
}

/**
 * Wrap a handler so a defect becomes a readable tool error.
 *
 * An MCP tool that throws takes the whole call down with a stack trace the
 * model then tries to interpret. A refusal is a returned value everywhere else
 * in Kertel, and it should be one here too.
 */
async function guard(run: () => Promise<TextResult> | TextResult): Promise<TextResult> {
  try {
    return await run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return text(`Kertel hit an internal error and did nothing: ${message}`, true);
  }
}

export function buildServer(runtime: Runtime): McpServer {
  const server = new McpServer(
    { name: "kertel", version: VERSION },
    {
      instructions: [
        "Kertel is an evidence-driven trading agent for Binance Spot. You are its reasoning layer.",
        "",
        "How to work with it:",
        "- Call kertel_status first if you are unsure what is available. It never lies about capability.",
        "- kertel_research returns evidence and a cost receipt. It does NOT return a verdict — that is your job.",
        "  Read the sources, note what was skipped and why, and say what you actually conclude.",
        "- Research costs real money over x402: about $0.01 for a price check, $0.06 for a full thesis.",
        "  Use price_check unless the question is genuinely whether to trade.",
        "- kertel_propose prices an order and returns a one-use code. It does not place anything.",
        "- kertel_confirm places the order. It is irreversible. Only ever pass a code the human typed.",
        "  Never invent, complete, guess or reuse a code.",
        "- Futures (kertel_futures_*) is leveraged and can lose more than the margin. The same code",
        "  discipline applies. Kertel forces isolated margin and caps leverage; do not argue with either.",
        "  Report the liquidation distance whenever you report a futures position.",
        "",
        "When Kertel refuses, the refusal is the answer. Report it and its reason; do not work around it,",
        "retry it with different numbers, or reach for another tool to do the same thing.",
        "",
        "Memory. Kertel's state lives in a local database, so on a new machine it starts blank and its",
        "monitor would sit idle over live positions. It holds no memory credential of its own — you carry",
        "that. If the user has an Agent Memory tool available, run this loop every session:",
        "1. AT THE START: `recall` for this project. If you find a Kertel snapshot, pass it to",
        "   kertel_restore before doing anything else, so it resumes the positions it was managing.",
        "   Pass any lessons you find to kertel_learn.",
        "2. AFTER ANYTHING IMPORTANT — an exit, a new plan, a cancellation — call kertel_snapshot and",
        "   `remember` the result so the next machine picks up from there.",
        "3. AFTER POSITIONS CLOSE: call kertel_memory_digest and `remember` that too.",
        "Without step 1 the agent forgets it holds anything. Without step 2 the next session does.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "kertel_status",
    {
      title: "Kertel status",
      description:
        "What Kertel can and cannot currently do: mode, research wallet and payment rails, spend against " +
        "the daily cap, trading limits, the kill switch, and anything unreconciled. Local state only, no " +
        "network. Check this before claiming any capability is available.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const { statusTool } = await import("./tools/status.js");
        const result = await statusTool(runtime).execute("mcp", {});
        return text(result.content[0]?.text ?? "");
      }),
  );

  server.registerTool(
    "kertel_research",
    {
      title: "Kertel research",
      description:
        "Research a symbol using the cheapest sufficient set of sources, and return the evidence with a " +
        "receipt of what was read, what it cost, and what was deliberately not read. " +
        "goal='price_check' (~$0.01) answers what the price is doing. " +
        "goal='trade_thesis' (~$0.06) additionally buys Nansen Smart Money flows and is only worth it when " +
        "the question is whether to trade. Returns evidence, not a verdict: you draw the conclusion.",
      inputSchema: {
        symbol: z.string().describe("Spot symbol, uppercase, for example ETHUSDT."),
        goal: z
          .enum(["price_check", "trade_thesis"])
          .describe("price_check is five times cheaper. Do not use trade_thesis for a price question."),
      },
    },
    async ({ symbol, goal }) =>
      guard(async () => {
        const result = await runtime.research({ symbol, goal });
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_propose",
    {
      title: "Kertel propose trade",
      description:
        "Price a Spot market order, check it against every limit and the exchange's own filters, and " +
        "return it with a one-use confirmation code. This does NOT place an order. The amount is in quote " +
        "currency; the exchange minimum is 5.00 USDT.",
      inputSchema: {
        symbol: z.string().describe("Spot symbol, uppercase."),
        side: z.enum(["BUY", "SELL"]),
        notional: z.string().describe('Amount in quote currency as a decimal string, e.g. "10".'),
      },
    },
    async ({ symbol, side, notional }) =>
      guard(async () => {
        const result = await runtime.propose({ symbol, side, notional });
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_confirm",
    {
      title: "Kertel confirm trade",
      description:
        "Place the order the human already approved, using the exact code from the proposal. " +
        "THIS SPENDS REAL MONEY AND CANNOT BE UNDONE. Only call it with a KTL- code the human typed in " +
        "their own message. Never invent, complete, guess or reuse a code, and never call this to test " +
        "whether a code is valid.",
      inputSchema: {
        code: z.string().describe("The confirmation code exactly as the human typed it, e.g. KTL-4B7QK2."),
      },
    },
    async ({ code }) =>
      guard(async () => {
        const result = await runtime.confirm(code);
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_cancel",
    {
      title: "Kertel cancel proposal",
      description:
        "Drop the order waiting for confirmation and invalidate its code. Cannot cancel an order that has " +
        "already been placed.",
      inputSchema: {},
    },
    async () => guard(() => text(runtime.cancel().body)),
  );

  server.registerTool(
    "kertel_reconcile",
    {
      title: "Kertel reconcile",
      description:
        "Ask the exchange what actually happened to any order Kertel sent but never got an answer for, and " +
        "list any research payment signed without confirmation. Read-only. Run after any 'result unknown'.",
      inputSchema: {},
    },
    async () => guard(async () => text(await runtime.reconcile())),
  );

  server.registerTool(
    "kertel_stop",
    {
      title: "Kertel stop",
      description:
        "Engage the kill switch. Kertel refuses all research, proposals, orders and autonomous exits until " +
        "explicitly resumed. Survives a restart. Use it the moment anything looks wrong.",
      inputSchema: { reason: z.string().describe("Why. Shown back on every subsequent refusal.") },
    },
    async ({ reason }) =>
      guard(() => {
        runtime.store.engageKillSwitch(reason, runtime.clock.now());
        return text(`Kertel is stopped: ${reason}\n\nNothing will run until it is resumed.`);
      }),
  );

  server.registerTool(
    "kertel_resume",
    {
      title: "Kertel resume",
      description:
        "Release the kill switch. Refuses while anything is unreconciled, because resuming with money in " +
        "an unknown state just resumes the uncertainty.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const { resumeTool } = await import("./tools/trade.js");
        const result = await resumeTool(runtime).execute("mcp", {});
        return text(result.content[0]?.text ?? "", result.isError === true);
      }),
  );

  // ---- Autonomy: the plan, and everything that runs off it. -----------------

  server.registerTool(
    "kertel_plan_exit",
    {
      title: "Kertel plan exit",
      description:
        "Draft a standing exit plan for a position Kertel will then manage on its own: scale out at " +
        "profit targets, a stop, an optional trailing stop, and an optional move to breakeven. " +
        "Returns the plan with the ACTUAL PRICES each leg fires at, plus a one-use code to arm it. " +
        "Nothing is watched until the human arms it with kertel_arm. " +
        "Percentages are basis points: 5000 = +50%, 1500 = -15%.",
      inputSchema: {
        symbol: z.string().describe("Spot symbol, uppercase."),
        takeProfit: z
          .array(
            z.object({
              atBps: z.number().int().positive().describe("Basis points above entry, 5000 = +50%."),
              fractionBps: z
                .number()
                .int()
                .positive()
                .max(10000)
                .describe("Share of the position to sell, 3333 = a third."),
            }),
          )
          .default([])
          .describe("Scale-out rungs. A trader takes some off at the first target and lets the rest run."),
        stopLossBps: z.number().int().positive().nullable().default(null),
        trailingActivateAtBps: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .default(null)
          .describe("Gain at which a trailing stop switches on. Null disables trailing."),
        trailingBps: z.number().int().positive().nullable().default(null),
        breakevenAtBps: z
          .number()
          .int()
          .positive()
          .nullable()
          .default(null)
          .describe("Gain after which the stop moves to entry so the trade cannot lose."),
        quantity: z.string().nullable().default(null).describe("Null means the whole balance."),
        entryPrice: z
          .string()
          .nullable()
          .default(null)
          .describe("What the position cost. Null uses the current bid, which only suits a fresh entry."),
        holdDays: z.number().int().positive().max(90).default(30),
      },
    },
    async (args) =>
      guard(async () => {
        const trailing =
          args.trailingActivateAtBps === null || args.trailingBps === null
            ? null
            : { activateAtBps: args.trailingActivateAtBps, trailBps: args.trailingBps };
        const result = await runtime.planExit({
          symbol: args.symbol,
          ladder: args.takeProfit,
          stopLossBps: args.stopLossBps,
          trailing,
          breakevenAtBps: args.breakevenAtBps,
          quantity: args.quantity,
          entryPrice: args.entryPrice,
          holdDays: args.holdDays,
        });
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_arm",
    {
      title: "Kertel arm plan",
      description:
        "Hand Kertel a position to manage, using the code from the plan. After this it sells on its own " +
        "when the rules say so, WITHOUT asking again. Only ever pass a code the human typed.",
      inputSchema: { code: z.string().describe("The code from the plan, e.g. KTL-4B7QK2.") },
    },
    async ({ code }) =>
      guard(() => {
        const result = runtime.armPlan(code);
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_positions",
    {
      title: "Kertel positions",
      description:
        "Every position Kertel is managing: the plan, the peak reached, how much has been sold, and " +
        "where the stop currently sits. Local state, no network.",
      inputSchema: {},
    },
    async () => guard(() => text(runtime.positions())),
  );

  server.registerTool(
    "kertel_check_positions",
    {
      title: "Kertel check positions",
      description:
        "Run one pass over every armed plan right now: read the price, ratchet the stops, and act on " +
        "anything that has come due. The monitor does this on a timer anyway; this forces it immediately.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const result = await runtime.checkPositions();
        if (result.halted !== null) {
          return text(["The monitor is halted.", "", result.halted].join("\n"), true);
        }
        if (result.checked === 0) {
          return text("No armed plans to check.");
        }
        return text(
          [
            `Checked ${String(result.checked)} position(s), ${String(result.fired)} acted on.`,
            "",
            ...result.lines,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "kertel_cancel_plan",
    {
      title: "Kertel cancel plan",
      description:
        "Stop managing a position. The position itself is untouched and becomes the human's again.",
      inputSchema: { id: z.string().describe("The plan id from kertel_positions.") },
    },
    async ({ id }) =>
      guard(() => {
        const result = runtime.cancelPlan(id);
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_journal",
    {
      title: "Kertel journal",
      description:
        "What Kertel has actually done and why, newest first — including the times it looked and chose " +
        "to do nothing. This is the record to read before trusting it with more.",
      inputSchema: {
        limit: z.number().int().positive().max(200).default(25),
        withEvidence: z
          .boolean()
          .default(false)
          .describe("Include the research receipts behind decisions that took evidence."),
      },
    },
    async ({ limit, withEvidence }) => guard(() => text(runtime.journal(limit, withEvidence))),
  );

  // ---- Holdings, track record, and the memory loop. -------------------------

  server.registerTool(
    "kertel_watch",
    {
      title: "Kertel watch holdings",
      description:
        "Sweep what the account actually holds and flag what is unguarded: positions with no exit plan, " +
        "plans with no stop, holdings too small to ever sell, and concentration. Free by default — it " +
        "reads the exchange and Kertel's own records. Set deep=true to buy Smart Money evidence on the " +
        "flagged holdings only (about $0.06 each).",
      inputSchema: {
        deep: z
          .boolean()
          .default(false)
          .describe("Buy paid research on flagged holdings. Costs real money; leave false to look for free."),
      },
    },
    async ({ deep }) => guard(async () => text(await runtime.watch(deep))),
  );

  server.registerTool(
    "kertel_review",
    {
      title: "Kertel review",
      description:
        "How Kertel has actually done: closed positions, win rate, average outcome, how much was given " +
        "back from the peak, and how often a stop was hit on something that then recovered. Derived from " +
        "records written when each exit fired, not from recollection. Read this before trusting it with more.",
      inputSchema: { limit: z.number().int().positive().max(500).default(100) },
    },
    async ({ limit }) => guard(() => text(runtime.review(limit))),
  );

  server.registerTool(
    "kertel_memory_digest",
    {
      title: "Kertel memory digest",
      description:
        "A portable summary of Kertel's trading record and the lessons in it, dated and written so a " +
        "fresh session on another machine can act on it. " +
        "STORE THE RESULT with the user's Agent Memory `remember` tool, under a folder named for this " +
        "project. Kertel deliberately holds no memory credential of its own, so you are the bridge.",
      inputSchema: { limit: z.number().int().positive().max(500).default(100) },
    },
    async ({ limit }) => guard(() => text(runtime.memoryDigest(limit))),
  );

  server.registerTool(
    "kertel_learn",
    {
      title: "Kertel learn",
      description:
        "Hand Kertel lessons you recalled from Agent Memory so they apply to the next decision. " +
        "Call Agent Memory's `recall` first, then pass anything it returned about how this account trades. " +
        "Stored lessons are shown on every future exit plan for the symbol they concern — which is the " +
        "moment they matter, rather than in a report nobody opens. " +
        "Use symbol='*' for something true of the account generally rather than of one pair.",
      inputSchema: {
        lessons: z
          .array(
            z.object({
              symbol: z.string().describe("Symbol the lesson is about, or '*' for all."),
              text: z.string().min(1).describe("The lesson, in a sentence somebody can act on."),
            }),
          )
          .min(1),
      },
    },
    async ({ lessons }) => guard(() => text(runtime.learn(lessons))),
  );

  server.registerTool(
    "kertel_snapshot",
    {
      title: "Kertel snapshot",
      description:
        "Kertel's working state as portable text: every position it is managing, each plan's ladder, " +
        "stop, trailing config, HIGH-WATER MARK and how much has already been sold, plus past exits and " +
        "lessons. " +
        "STORE THE RESULT with the user's Agent Memory `remember` tool. On any other machine, recall it " +
        "and pass it to kertel_restore to pick the positions up mid-flight. " +
        "Take a fresh snapshot after anything important happens — an exit, a new plan, a cancellation.",
      inputSchema: {},
    },
    async () => guard(() => text(runtime.snapshot())),
  );

  server.registerTool(
    "kertel_restore",
    {
      title: "Kertel restore",
      description:
        "Resume the positions from a snapshot on this machine. Recall the snapshot from Agent Memory " +
        "first and pass it verbatim. " +
        "Kertel rebuilds what was intended, then CHECKS IT AGAINST WHAT THE ACCOUNT ACTUALLY HOLDS and " +
        "reports anything that drifted — a position sold by hand since the snapshot comes back marked " +
        "unfulfillable rather than as something it will try to sell. " +
        "The kill switch is never carried: safety is per machine.",
      inputSchema: {
        snapshot: z.string().min(10).describe("The snapshot text, exactly as it was stored."),
      },
    },
    async ({ snapshot: body }) =>
      guard(async () => {
        const result = await runtime.restore(body);
        return text(result.body, !result.ok);
      }),
  );

  // ---- Futures. Leveraged, so every guard is tighter. -----------------------

  server.registerTool(
    "kertel_futures_open",
    {
      title: "Kertel open futures position",
      description:
        "Price a USDⓈ-M futures position and return a one-use code. Does NOT open anything. " +
        "Kertel forces ISOLATED margin and caps leverage, because Binance defaults to 20x on cross, " +
        "where an ordinary day's move is the whole margin and the entire wallet backs the position. " +
        "The amount is the POSITION notional, not the margin: at 3x, a 30 USDT position needs about " +
        "10 USDT of margin. Binance's futures minimum is 20 USDT of position on most pairs. " +
        "The proposal shows where the exchange would liquidate you.",
      inputSchema: {
        symbol: z.string().describe("Futures symbol, uppercase, for example ETHUSDT."),
        side: z.enum(["BUY", "SELL"]).describe("BUY opens a long, SELL opens a short."),
        notional: z.string().describe('Position size in quote currency, e.g. "30".'),
        leverage: z
          .number()
          .int()
          .min(1)
          .default(3)
          .describe("Whole number. Kertel refuses anything above its configured ceiling."),
      },
    },
    async ({ symbol, side, notional, leverage }) =>
      guard(async () => {
        const result = await runtime.proposeFutures({ symbol, side, notional, leverage });
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_futures_confirm",
    {
      title: "Kertel confirm futures position",
      description:
        "Open the futures position the human approved, using the exact code. " +
        "THIS OPENS A LEVERAGED POSITION THAT CAN LOSE MORE THAN THE MARGIN AND CANNOT BE UNDONE. " +
        "Only ever pass a code the human typed. Never invent, complete, guess or reuse one.",
      inputSchema: { code: z.string().describe("The code from the futures proposal.") },
    },
    async ({ code }) =>
      guard(async () => {
        const result = await runtime.confirmFutures(code);
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_futures_close",
    {
      title: "Kertel close futures position",
      description:
        "Close an open futures position, in full or in part, with a reduce-only order so a repeat " +
        "cannot flip it instead of closing it. No confirmation code: getting OUT is the safe " +
        "direction, and a code between a human and an exit costs money exactly when it matters.",
      inputSchema: {
        symbol: z.string(),
        fractionBps: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(10000)
          .describe("10000 closes all of it, 5000 closes half."),
      },
    },
    async ({ symbol, fractionBps }) =>
      guard(async () => {
        const result = await runtime.closeFutures(symbol, fractionBps);
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "kertel_futures_positions",
    {
      title: "Kertel futures positions",
      description:
        "Open futures positions with entry, mark, unrealised PnL, leverage, margin mode, and HOW FAR " +
        "THE PRICE IS FROM LIQUIDATION. Warns when liquidation sits inside an ordinary day's range, " +
        "or when a position is on cross margin.",
      inputSchema: {
        symbols: z
          .array(z.string())
          .default(["ETHUSDT", "BTCUSDT"])
          .describe("Which symbols to check. Futures has no cheap list-all."),
      },
    },
    async ({ symbols }) => guard(async () => text(await runtime.describeFutures(symbols))),
  );

  return server;
}

/**
 * Load the repository's `.env`, if it is there.
 *
 * An MCP client launches this process with whatever environment it feels like,
 * which for most clients is almost nothing. Without this, an operator who has
 * correctly filled in `.env` gets a server that reports every capability
 * missing and no clue why. Explicit environment variables from the client still
 * win: `loadEnvFile` does not overwrite what is already set.
 */
function loadDotEnv(): string | null {
  // dist/mcp.js -> apps/kertel-plugin/dist -> repository root.
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(envPath)) {
    return null;
  }
  try {
    process.loadEnvFile(envPath);
    return envPath;
  } catch {
    // A malformed .env is the operator's to fix, and saying so beats starting
    // up pretending nothing was configured.
    return null;
  }
}

async function main(): Promise<void> {
  const envPath = loadDotEnv();

  // stderr, always. stdout is the JSON-RPC stream.
  const log = createLogger({
    level: process.env["KERTEL_LOG_LEVEL"] === undefined ? "info" : "info",
    write: (line) => process.stderr.write(`${line}\n`),
  }).child({ component: "kertel-mcp" });

  let runtime: Runtime;
  try {
    runtime = createRuntime({ config: loadConfig(process.env) });
  } catch (cause) {
    const message = cause instanceof ConfigError ? cause.message : String(cause);
    log.error("kertel could not start", { problem: message });
    process.stderr.write(`\nKertel could not start.\n${message}\n`);
    process.exitCode = 1;
    return;
  }

  const server = buildServer(runtime);
  await server.connect(new StdioServerTransport());
  // Autonomy is the product. The loop starts with the server, not on request.
  runtime.monitor.start();
  log.info("kertel mcp server ready", {
    mode: runtime.mode,
    envFile: envPath,
    degraded: runtime.config.degraded,
  });

  const shutdown = (): void => {
    runtime.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when executed directly, so tests can import `buildServer`.
if (process.argv[1] !== undefined && process.argv[1].includes("mcp")) {
  void main();
}
