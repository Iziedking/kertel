/**
 * `telt_research` — buy the least evidence that answers the question.
 *
 * The two goals are separated at the tool boundary rather than inferred,
 * because they cost five times different amounts. "What is ETH doing" is a
 * `price_check` at a cent. "Should I buy ETH" is a `trade_thesis` at six.
 * Letting the model pick between them from the phrasing of a WhatsApp message
 * is how a research agent quietly runs up a bill answering questions nobody
 * asked, so the model must say which it wants and the receipt shows what that
 * choice cost.
 *
 * What the model cannot do here is more interesting than what it can. It cannot
 * name an endpoint, a provider, a URL, or an amount to spend. `symbol` is
 * checked against a closed table before anything is called, and the escalation
 * ladder is deterministic code. The tool's entire input surface is one enum and
 * one symbol.
 */

import { Type } from "@sinclair/typebox";

import type { ResearchGoal } from "@telt/core/research";

import type { Runtime } from "../runtime.js";
import { textResult } from "./types.js";
import type { AgentTool } from "./types.js";

const GOALS: readonly ResearchGoal[] = ["price_check", "trade_thesis"];

function goalOf(raw: unknown): ResearchGoal | null {
  return typeof raw === "string" && (GOALS as readonly string[]).includes(raw)
    ? (raw as ResearchGoal)
    : null;
}

export function researchTool(runtime: Runtime): AgentTool {
  const allowed = runtime.config.policy.trading.allowedSymbols.join(", ");

  return {
    name: "telt_research",
    label: "Telt research",
    description:
      "Research a Spot symbol using the cheapest sufficient set of sources, and return a receipt showing " +
      "what was read, what it cost, and what was deliberately not read. " +
      `Allowed symbols: ${allowed}. ` +
      "Use goal='price_check' (about $0.01) when the question is what the price is doing. " +
      "Use goal='trade_thesis' (about $0.06) only when the question is whether to trade, because it buys " +
      "Smart Money flow data. This tool never places an order.",
    parameters: Type.Object(
      {
        symbol: Type.String({
          description: `The Spot symbol, uppercase. One of: ${allowed}.`,
          minLength: 5,
          maxLength: 20,
        }),
        goal: Type.Union([Type.Literal("price_check"), Type.Literal("trade_thesis")], {
          description:
            "price_check answers what the price is doing and stops there. trade_thesis additionally buys " +
            "flow evidence and costs about five times as much.",
        }),
      },
      { additionalProperties: false },
    ),
    ownerOnly: true,

    async execute(_toolCallId, params) {
      const symbol = typeof params["symbol"] === "string" ? params["symbol"] : "";
      const goal = goalOf(params["goal"]);

      if (symbol.trim() === "") {
        return textResult("Telt needs a symbol to research, for example ETHUSDT.", true);
      }
      if (goal === null) {
        // Not defaulted. Guessing `trade_thesis` costs six cents nobody asked
        // for, and guessing `price_check` answers a different question than the
        // one that was asked.
        return textResult(
          "Telt needs to know whether this is a price_check or a trade_thesis. They cost about $0.01 and $0.06.",
          true,
        );
      }

      const result = await runtime.research({ symbol, goal });
      return textResult(result.body, !result.ok);
    },
  };
}
