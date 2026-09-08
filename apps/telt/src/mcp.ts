#!/usr/bin/env node
/**
 * Telt as an MCP server.
 *
 * This is the primary surface. Binance's Agent OS is reached from Claude Code,
 * Claude, Codex, ChatGPT and VS Code, so that is where an agent built on it
 * belongs — the reasoning layer is the client's model, and Telt is the thing
 * it reasons *with*.
 *
 * That split is the point. Telt does not write the verdict and does not own
 * an LLM key. It gathers evidence deterministically, prices it, refuses what it
 * cannot justify, and hands back structured facts with a receipt showing what
 * was bought and what was deliberately skipped. The model reads that and forms
 * the view. A model cannot talk Telt into an endpoint, a price, or an order
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
 * in Telt, and it should be one here too.
 */
async function guard(run: () => Promise<TextResult> | TextResult): Promise<TextResult> {
  try {
    return await run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return text(`Telt hit an internal error and did nothing: ${message}`, true);
  }
}

export function buildServer(runtime: Runtime): McpServer {
  const server = new McpServer(
    { name: "telt", version: VERSION },
    {
      instructions: [
        "Telt is an evidence-driven trading agent for Binance spot and USDⓈ-M futures. You are its",
        "reasoning layer.",
        "",
        "TALKING TO THE USER. Never make them name a tool. They speak plainly; you choose the calls and",
        "chain them without being asked. Map what they say onto this:",
        "",
        "- \"what is moving\" / \"anything interesting\" / \"find me something\" / \"what should I look at\"",
        "    -> telt_scan. It is free, so run it rather than asking them to name a token. Then offer",
        "      to research whichever candidate they react to. Never call a scan result a signal.",
        "- \"can I buy X\" / \"is X a good buy\" / \"what do you think of X\" / \"check X for me\"",
        "    -> telt_research FIRST, then give YOUR verdict from the evidence, then offer the trade.",
        "      A buy question is a research question. Do not price an order as the answer to it.",
        "- \"buy me $20 of X\" / \"get me some X\" / \"long X at 3x\"",
        "    -> telt_propose (or telt_futures_open). Show the numbers. Stop. Wait for their code.",
        "      They have decided; do not research unprompted, but do say if you have no evidence.",
        "- \"how am I doing\" / \"what am I holding\" / \"any risks\" / \"should I worry\"",
        "    -> telt_watch, then telt_positions. Lead with anything unprotected or near a stop.",
        "      For a futures position always state how far liquidation is.",
        "- \"sell half at 50% up\" / \"take profits\" / \"protect this\" / \"set a stop\"",
        "    -> telt_plan_exit, show the real prices each leg fires at, then telt_arm on their say-so.",
        "      Works on futures as well as spot, and finds which by itself. Once armed, Telt trims,",
        "      trails and stops out on its own — that is the point of it, so say so plainly.",
        "- \"sell it\" / \"get me out\" / \"close it\"",
        "    -> telt_propose SELL for spot, telt_futures_close for futures.",
        "- \"what did you do\" / \"how have my trades gone\" -> telt_journal, then telt_review.",
        "- \"go find me something\" / \"anything worth doing\" -> telt_hunt, if a budget is armed.",
        "- \"you can spend $10 on your own ideas\" -> telt_autonomy_arm. Say the numbers back first.",
        "",
        "AUTONOMY. telt_hunt is the only path where Telt opens a position nobody asked for, and it",
        "needs a budget armed by the human first. Never arm one on your own initiative, never pick",
        "the amount for them, and never describe Telt as acting unattended without checking",
        "telt_autonomy_status. A hunt that ends in no trade is the normal outcome; report it as",
        "discipline, not as failure.",
        "",
        "Chain the obvious next step instead of stopping to ask permission for a read. Reads are free and",
        "harmless: status, watch, positions, journal, review. Only two things need the human, and they",
        "need them absolutely: spending money on research, and a confirmation code.",
        "",
        "Answer in your own words. Telt returns a receipt, not a conclusion; do not paste it back and",
        "call that an answer. Say what you think, then show the numbers that support it.",
        "",
        "Not every symbol has paid coverage. Telt trades anything Binance lists, but only some",
        "instruments have verified CoinGecko/CoinMarketCap/Nansen ids, and the rest refuse BY NAME on the",
        "receipt rather than guessing an id and pricing the wrong asset. When that happens, say so plainly",
        "-- \"the paid sources have no verified id for this, so this is venue data only\" -- and let the",
        "user decide. Never present single-source venue data as corroborated research.",
        "",
        "How to work with it:",
        "- Call telt_status first if you are unsure what is available. It never lies about capability.",
        "- telt_research returns evidence and a cost receipt. It does NOT return a verdict — that is your job.",
        "  Read the sources, note what was skipped and why, and say what you actually conclude.",
        "- Research costs real money over x402: about $0.01 for a price check, $0.06 for a full thesis.",
        "  Use price_check unless the question is genuinely whether to trade.",
        "- telt_propose prices an order and returns a one-use code. It does not place anything.",
        "- telt_confirm places the order. It is irreversible. Only ever pass a code the human typed.",
        "  Never invent, complete, guess or reuse a code.",
        "- Futures (telt_futures_*) is leveraged and can lose more than the margin. The same code",
        "  discipline applies. Telt forces isolated margin and caps leverage; do not argue with either.",
        "  Report the liquidation distance whenever you report a futures position.",
        "  A leveraged position with no exit plan is the single most important thing telt_watch can",
        "  tell you about, because it is the only kind the exchange can close for you. Never leave one",
        "  unmentioned, and offer telt_plan_exit when you find it.",
        "",
        "When Telt refuses, the refusal is the answer. Report it and its reason; do not work around it,",
        "retry it with different numbers, or reach for another tool to do the same thing.",
        "",
        "Memory. Telt's state lives in a local database, so on a new machine it starts blank and its",
        "monitor would sit idle over live positions. It holds no memory credential of its own — you carry",
        "that. If the user has an Agent Memory tool available, run this loop every session:",
        "1. AT THE START: `recall` for this project. If you find a Telt snapshot, pass it to",
        "   telt_restore before doing anything else, so it resumes the positions it was managing.",
        "   Pass any lessons you find to telt_learn.",
        "2. AFTER ANYTHING IMPORTANT — an exit, a new plan, a cancellation — call telt_snapshot and",
        "   `remember` the result so the next machine picks up from there.",
        "3. AFTER POSITIONS CLOSE: call telt_memory_digest and `remember` that too.",
        "Without step 1 the agent forgets it holds anything. Without step 2 the next session does.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "telt_status",
    {
      title: "Telt status",
      description:
        "What Telt can and cannot currently do: mode, research wallet and payment rails, spend against " +
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
    "telt_scan",
    {
      title: "Telt scan",
      description:
        "What is moving on Binance over the last 24 hours, above a liquidity floor. Use this when " +
        "the user asks an open question -- what is moving, anything interesting, what should I look " +
        "at, find me something -- rather than naming a token themselves. Free: it reads the venue's " +
        "own 24-hour ticker and spends nothing. Returns gainers AND fallers, because a collapse is " +
        "as tradeable as a pump. This is a momentum screen and NOT a recommendation: nothing " +
        "returned has been researched, and you must not present it as a signal. The next step after " +
        "it is always telt_research on whichever candidate the user is drawn to.",
      inputSchema: {
        minQuoteVolume: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .default("5000000")
          .describe(
            "Minimum 24h traded value in USDT. Below a few million a large percentage move is a " +
              "handful of trades, not a market. Lower it only when the user asks for smaller pairs.",
          ),
        limit: z.number().int().positive().max(25).default(8),
      },
    },
    async ({ minQuoteVolume, limit }) => guard(async () => text(await runtime.scan(minQuoteVolume, limit))),
  );

  server.registerTool(
    "telt_hunt",
    {
      title: "Telt hunt",
      description:
        "Look for something worth trading and act on it, alone. Telt scans the venue, picks ONE " +
        "candidate, pays for evidence about it, reasons over that evidence with its own model, and " +
        "opens a position ONLY if the verdict is confident, states its risks, and there is " +
        "discretionary budget left. Anything it opens is protected with an exit plan in the same " +
        "run. Most runs correctly end in no trade -- that is the design, not a failure. Requires a " +
        "budget armed with telt_autonomy_arm; without one it refuses and explains. Use when the " +
        "user asks Telt to go looking, or to check whether there is anything worth doing.",
      inputSchema: {},
    },
    async () => guard(async () => text((await runtime.hunt()).body)),
  );

  server.registerTool(
    "telt_autonomy_arm",
    {
      title: "Telt arm autonomy",
      description:
        "Grant Telt a budget it may spend on ideas of its own, without asking each time. This is " +
        "the ONLY way Telt can open a position nobody requested. It replaces any existing budget " +
        "rather than adding to it. The budget depletes and does not refill; it expires; futures is " +
        "charged the margin rather than the notional; and every other limit -- per-trade cap, " +
        "slippage, daily loss, kill switch -- still applies unchanged. Read the amount back to the " +
        "user before calling this, and never choose the numbers for them.",
      inputSchema: {
        granted: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe("Total the agent may commit, in USDT. Say it back to the user before arming."),
        perTrade: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe("Most that may go into any single self-found idea."),
        hours: z
          .number()
          .int()
          .positive()
          .max(168)
          .default(24)
          .describe("How long the permission lasts. Consent should not outlive the day it was given."),
      },
    },
    async ({ granted, perTrade, hours }) =>
      guard(async () => text(runtime.autonomy.arm({ granted, perTrade, hours }))),
  );

  server.registerTool(
    "telt_autonomy_status",
    {
      title: "Telt autonomy status",
      description:
        "What Telt may spend on its own ideas, what it has already committed, and how long the " +
        "permission lasts. Pass paused to stop or resume it without losing the remaining budget. " +
        "Check this before telling a user Telt is or is not acting unattended.",
      inputSchema: {
        paused: z
          .boolean()
          .optional()
          .describe("Set true to stop Telt acting on its own; false to resume. Omit to just read."),
      },
    },
    async ({ paused }) =>
      guard(async () =>
        text(paused === undefined ? runtime.autonomy.status() : runtime.autonomy.pause(paused)),
      ),
  );

  server.registerTool(
    "telt_verify",
    {
      title: "Telt verify",
      description:
        "Check a Telt proof of research. Paste the TELT-ATTESTATION-1 block and this recovers who " +
        "signed it, confirms the signature matches the agent it names, and returns the blockchain " +
        "links for the payments so the reader can check those themselves. Works on ANY attestation, " +
        "including ones this Telt did not produce -- that is the point of it. Reads no local state " +
        "and needs no credentials. Use it whenever someone shows you an attestation and asks whether " +
        "it is real, and never claim a payment is confirmed unless you followed the link and saw it.",
      inputSchema: {
        attestation: z
          .string()
          .min(1)
          .describe("The full attestation text, from the TELT-ATTESTATION-1 line to the sig= line."),
      },
    },
    async ({ attestation }) => guard(async () => text(await runtime.verify(attestation))),
  );

  server.registerTool(
    "telt_research",
    {
      title: "Telt research",
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
    "telt_propose",
    {
      title: "Telt propose trade",
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
    "telt_confirm",
    {
      title: "Telt confirm trade",
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
    "telt_cancel",
    {
      title: "Telt cancel proposal",
      description:
        "Drop the order waiting for confirmation and invalidate its code. Cannot cancel an order that has " +
        "already been placed.",
      inputSchema: {},
    },
    async () => guard(() => text(runtime.cancel().body)),
  );

  server.registerTool(
    "telt_reconcile",
    {
      title: "Telt reconcile",
      description:
        "Ask the exchange what actually happened to any order Telt sent but never got an answer for, and " +
        "list any research payment signed without confirmation. Read-only. Run after any 'result unknown'.",
      inputSchema: {},
    },
    async () => guard(async () => text(await runtime.reconcile())),
  );

  server.registerTool(
    "telt_stop",
    {
      title: "Telt stop",
      description:
        "Engage the kill switch. Telt refuses all research, proposals, orders and autonomous exits until " +
        "explicitly resumed. Survives a restart. Use it the moment anything looks wrong.",
      inputSchema: { reason: z.string().describe("Why. Shown back on every subsequent refusal.") },
    },
    async ({ reason }) =>
      guard(() => {
        runtime.store.engageKillSwitch(reason, runtime.clock.now());
        return text(`Telt is stopped: ${reason}\n\nNothing will run until it is resumed.`);
      }),
  );

  server.registerTool(
    "telt_resume",
    {
      title: "Telt resume",
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
    "telt_plan_exit",
    {
      title: "Telt plan exit",
      description:
        "Draft a standing exit plan for a position Telt will then manage on its own: scale out at " +
        "profit targets, a stop, an optional trailing stop, and an optional move to breakeven. " +
        "Returns the plan with the ACTUAL PRICES each leg fires at, plus a one-use code to arm it. " +
        "Nothing is watched until the human arms it with telt_arm. " +
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
        market: z
          .enum(["spot", "futures"])
          .optional()
          .describe(
            "Which venue holds the position. Omit and Telt works it out: an open futures " +
              "position in this symbol means futures, anything else means spot. Only say it " +
              "when both are held at once.",
          ),
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
          market: args.market ?? null,
        });
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "telt_arm",
    {
      title: "Telt arm plan",
      description:
        "Hand Telt a position to manage, using the code from the plan. After this it sells on its own " +
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
    "telt_positions",
    {
      title: "Telt positions",
      description:
        "Every position Telt is managing: the plan, the peak reached, how much has been sold, and " +
        "where the stop currently sits. Local state, no network.",
      inputSchema: {},
    },
    async () => guard(() => text(runtime.positions())),
  );

  server.registerTool(
    "telt_check_positions",
    {
      title: "Telt check positions",
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
    "telt_cancel_plan",
    {
      title: "Telt cancel plan",
      description:
        "Stop managing a position. The position itself is untouched and becomes the human's again.",
      inputSchema: { id: z.string().describe("The plan id from telt_positions.") },
    },
    async ({ id }) =>
      guard(() => {
        const result = runtime.cancelPlan(id);
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "telt_journal",
    {
      title: "Telt journal",
      description:
        "What Telt has actually done and why, newest first — including the times it looked and chose " +
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
    "telt_watch",
    {
      title: "Telt watch holdings",
      description:
        "Sweep what the account actually holds and flag what is unguarded: positions with no exit plan, " +
        "plans with no stop, holdings too small to ever sell, and concentration. Free by default — it " +
        "reads the exchange and Telt's own records. Set deep=true to buy Smart Money evidence on the " +
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
    "telt_review",
    {
      title: "Telt review",
      description:
        "How Telt has actually done: closed positions, win rate, average outcome, how much was given " +
        "back from the peak, and how often a stop was hit on something that then recovered. Derived from " +
        "records written when each exit fired, not from recollection. Read this before trusting it with more.",
      inputSchema: { limit: z.number().int().positive().max(500).default(100) },
    },
    async ({ limit }) => guard(() => text(runtime.review(limit))),
  );

  server.registerTool(
    "telt_memory_digest",
    {
      title: "Telt memory digest",
      description:
        "A portable summary of Telt's trading record and the lessons in it, dated and written so a " +
        "fresh session on another machine can act on it. " +
        "STORE THE RESULT with the user's Agent Memory `remember` tool, under a folder named for this " +
        "project. Telt deliberately holds no memory credential of its own, so you are the bridge.",
      inputSchema: { limit: z.number().int().positive().max(500).default(100) },
    },
    async ({ limit }) => guard(() => text(runtime.memoryDigest(limit))),
  );

  server.registerTool(
    "telt_learn",
    {
      title: "Telt learn",
      description:
        "Hand Telt lessons you recalled from Agent Memory so they apply to the next decision. " +
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
    "telt_snapshot",
    {
      title: "Telt snapshot",
      description:
        "Telt's working state as portable text: every position it is managing, each plan's ladder, " +
        "stop, trailing config, HIGH-WATER MARK and how much has already been sold, plus past exits and " +
        "lessons. " +
        "STORE THE RESULT with the user's Agent Memory `remember` tool. On any other machine, recall it " +
        "and pass it to telt_restore to pick the positions up mid-flight. " +
        "Take a fresh snapshot after anything important happens — an exit, a new plan, a cancellation.",
      inputSchema: {},
    },
    async () => guard(() => text(runtime.snapshot())),
  );

  server.registerTool(
    "telt_restore",
    {
      title: "Telt restore",
      description:
        "Resume the positions from a snapshot on this machine. Recall the snapshot from Agent Memory " +
        "first and pass it verbatim. " +
        "Telt rebuilds what was intended, then CHECKS IT AGAINST WHAT THE ACCOUNT ACTUALLY HOLDS and " +
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
    "telt_futures_open",
    {
      title: "Telt open futures position",
      description:
        "Price a USDⓈ-M futures position and return a one-use code. Does NOT open anything. " +
        "Telt forces ISOLATED margin and caps leverage, because Binance defaults to 20x on cross, " +
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
          .describe("Whole number. Telt refuses anything above its configured ceiling."),
      },
    },
    async ({ symbol, side, notional, leverage }) =>
      guard(async () => {
        const result = await runtime.proposeFutures({ symbol, side, notional, leverage });
        return text(result.body, !result.ok);
      }),
  );

  server.registerTool(
    "telt_futures_confirm",
    {
      title: "Telt confirm futures position",
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
    "telt_futures_close",
    {
      title: "Telt close futures position",
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
    "telt_futures_positions",
    {
      title: "Telt futures positions",
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
  // dist/mcp.js -> apps/telt/dist -> repository root.
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
    level: process.env["TELT_LOG_LEVEL"] === undefined ? "info" : "info",
    write: (line) => process.stderr.write(`${line}\n`),
  }).child({ component: "telt-mcp" });

  let runtime: Runtime;
  try {
    runtime = createRuntime({ config: loadConfig(process.env) });
  } catch (cause) {
    const message = cause instanceof ConfigError ? cause.message : String(cause);
    log.error("telt could not start", { problem: message });
    process.stderr.write(`\nTelt could not start.\n${message}\n`);
    process.exitCode = 1;
    return;
  }

  const server = buildServer(runtime);
  await server.connect(new StdioServerTransport());
  // Autonomy is the product. The loop starts with the server, not on request.
  runtime.monitor.start();
  log.info("telt mcp server ready", {
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
