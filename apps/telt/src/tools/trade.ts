/**
 * The tools that touch money.
 *
 * Every one is `optional: true` and `ownerOnly: true`, and the descriptions are
 * written for the model as much as for a human: a model that does not know
 * `telt_confirm` is irreversible will call it to "check" something.
 *
 * The split between propose and confirm is the product. The model can prepare
 * an order; it cannot place one. Placing requires a code that only ever existed
 * in the outbound message and in the owner's chat, which the model never sees
 * and cannot reconstruct — so a prompt injection that reaches the model reaches
 * a tool that prepares a proposal the owner then declines.
 */

import { Type } from "@sinclair/typebox";

import type { Runtime } from "../runtime.js";
import { textResult } from "./types.js";
import type { AgentTool } from "./types.js";

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

export function proposeTool(runtime: Runtime): AgentTool {
  const allowed = runtime.config.policy.trading.allowedSymbols.join(", ");
  return {
    name: "telt_propose",
    label: "Telt propose trade",
    description:
      "Prepare a Spot market order and return it for the owner to confirm. This does NOT place an order: " +
      "it prices the order, checks it against every limit and the exchange's own rules, and issues a " +
      `one-use confirmation code. Allowed symbols: ${allowed}. ` +
      "The amount is in quote currency (USDT). The exchange minimum is 5.00 and the configured per-trade " +
      "cap is the ceiling, so the usable range is narrow. Only the owner can confirm; you cannot.",
    parameters: Type.Object(
      {
        symbol: Type.String({ description: `Spot symbol, uppercase. One of: ${allowed}.` }),
        side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")]),
        notional: Type.String({
          description:
            "Amount to spend in quote currency, as a plain decimal string, for example \"10\" or \"12.50\".",
        }),
      },
      { additionalProperties: false },
    ),
    ownerOnly: true,

    async execute(_id, params) {
      const symbol = stringParam(params, "symbol");
      const side = stringParam(params, "side");
      const notional = stringParam(params, "notional");

      if (symbol === "" || notional === "") {
        return textResult("Telt needs a symbol and an amount to prepare an order.", true);
      }
      if (side !== "BUY" && side !== "SELL") {
        return textResult("Telt needs the side to be exactly BUY or SELL.", true);
      }

      const result = await runtime.propose({ symbol, side, notional });
      return textResult(result.body, !result.ok);
    },
  };
}

export function confirmTool(runtime: Runtime): AgentTool {
  return {
    name: "telt_confirm",
    label: "Telt confirm trade",
    description:
      "Place the order the owner already approved, using the exact one-use code from the proposal message. " +
      "THIS SPENDS REAL MONEY AND CANNOT BE UNDONE. Call it only when the owner has typed a code of the " +
      "form KTL-XXXXXX in their own message. Never invent, guess, complete or re-use a code, and never " +
      "call this to test whether a code is valid.",
    parameters: Type.Object(
      {
        code: Type.String({
          description: "The confirmation code exactly as the owner typed it, for example KTL-4B7QK2.",
          minLength: 6,
          maxLength: 40,
        }),
      },
      { additionalProperties: false },
    ),
    ownerOnly: true,

    async execute(_id, params) {
      const code = stringParam(params, "code");
      if (code === "") {
        return textResult("Telt needs the confirmation code the owner was given.", true);
      }
      const result = await runtime.confirm(code);
      return textResult(result.body, !result.ok);
    },
  };
}

export function cancelTool(runtime: Runtime): AgentTool {
  return {
    name: "telt_cancel",
    label: "Telt cancel proposal",
    description:
      "Drop the order waiting for confirmation and invalidate its code. Safe to call at any time; it " +
      "cannot cancel an order that has already been placed.",
    parameters: Type.Object({}, { additionalProperties: false }),
    ownerOnly: true,

    async execute() {
      const result = runtime.cancel();
      return textResult(result.body, !result.ok);
    },
  };
}

export function reconcileTool(runtime: Runtime): AgentTool {
  return {
    name: "telt_reconcile",
    label: "Telt reconcile",
    description:
      "Ask the exchange what actually happened to any order Telt sent but never got an answer for, and " +
      "list any research payment that was signed without confirmation. Read-only against the exchange. " +
      "Run this after any 'result unknown' message, before trading again.",
    parameters: Type.Object({}, { additionalProperties: false }),
    ownerOnly: true,

    async execute() {
      return textResult(await runtime.reconcile());
    },
  };
}

export function stopTool(runtime: Runtime): AgentTool {
  return {
    name: "telt_stop",
    label: "Telt stop",
    description:
      "Engage the kill switch. Telt immediately refuses all research, proposals and orders until it is " +
      "explicitly resumed, and the setting survives a restart. Use this the moment anything looks wrong.",
    parameters: Type.Object(
      {
        reason: Type.String({
          description: "Why it is being stopped. Shown back to the owner on every refusal.",
          minLength: 1,
          maxLength: 200,
        }),
      },
      { additionalProperties: false },
    ),
    ownerOnly: true,

    async execute(_id, params) {
      const reason = stringParam(params, "reason") || "stopped by the owner";
      runtime.store.engageKillSwitch(reason, runtime.clock.now());
      return textResult(
        `Telt is stopped: ${reason}\n\nNothing will run until it is resumed. This survives a restart.`,
      );
    },
  };
}

export function resumeTool(runtime: Runtime): AgentTool {
  return {
    name: "telt_resume",
    label: "Telt resume",
    description:
      "Release the kill switch. Refuses while anything is still unreconciled, because resuming with an " +
      "order or a payment in an unknown state means trading on numbers Telt cannot vouch for.",
    parameters: Type.Object({}, { additionalProperties: false }),
    ownerOnly: true,

    async execute() {
      const pending = runtime.store.trades.unreconciledOperations();
      const payments = runtime.store.unresolvedPayments();

      if (pending.length > 0 || payments.length > 0) {
        // Not a formality. The kill switch was engaged because Telt lost track
        // of money; releasing it without finding that money just resumes the
        // uncertainty.
        const lines = ["Telt will not resume yet.", ""];
        for (const operation of pending) {
          lines.push(`  order ${operation.id} is still ${operation.status}`);
        }
        for (const payment of payments) {
          lines.push(`  payment ${payment.attemptId} to ${payment.provider} is unconfirmed`);
        }
        lines.push("");
        lines.push("Run telt_reconcile first.");
        return textResult(lines.join("\n"), true);
      }

      runtime.store.releaseKillSwitch();
      return textResult("Telt is running again. Nothing is left unreconciled.");
    },
  };
}
