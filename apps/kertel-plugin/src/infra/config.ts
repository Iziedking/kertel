/**
 * Turning environment variables into a policy, or refusing to.
 *
 * Two rules govern this file.
 *
 * **An unset variable disables one feature loudly. It does not take the process
 * down.** A gateway that refuses to boot because one name is misspelled fails
 * at three in the morning, for everybody, over a research provider nobody was
 * using. So every optional pillar reports itself unavailable and the health
 * output says which and why.
 *
 * **A variable that is set but wrong is a hard error.** `KERTEL_MAX_TRADE_NOTIONAL=fifty`
 * is not a disabled feature, it is an operator who believes a limit is in force
 * that is not. That must be caught at boot, not at the moment an order is
 * sized.
 *
 * The distinction is the whole of the design: absent means off, present means
 * it must parse.
 */

import { z } from "zod";

import * as fp from "@kertel/core/money";
import { seconds } from "@kertel/core/domain";
import type { RunMode, Symbol_ } from "@kertel/core/domain";
import { defaultPolicy, validatePolicy } from "@kertel/core/policy";
import type { Policy } from "@kertel/core/policy";
import { PAYMENT_RAILS } from "@kertel/x402";
import type { PaymentRail } from "@kertel/x402";

export type RailPreference = "auto" | "bsc-only" | "base-only";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** A plain decimal string, the only money format that crosses this boundary. */
const decimal = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "must be a plain decimal amount, for example 25 or 0.06");

const integer = z.string().trim().regex(/^\d+$/, "must be a whole number");

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "must be an E.164 phone number, for example +2348012345678");

/** 0x-prefixed 32-byte hex. Checked for shape only; never logged. */
const privateKey = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

const symbols = z
  .string()
  .trim()
  .transform((raw) => raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(
            /^(\*|[A-Z0-9]{5,20})$/,
            "symbols are uppercase, for example ETHUSDT, or * for anything Binance lists",
          ),
      )
      .min(1),
  );

export type KertelConfig = {
  readonly mode: RunMode;
  readonly dataDir: string;
  readonly logLevel: "silent" | "error" | "warn" | "info" | "debug" | "trace";
  /** Null means no owner is configured and every command is refused. */
  readonly ownerWhatsApp: string | null;
  /** Per-deployment salt for sender hashing. Derived, never configured. */
  readonly senderSalt: string;
  readonly policy: Policy;
  readonly railPreference: RailPreference;
  /** Null means no research wallet, so every paid call refuses early. */
  readonly x402PrivateKey: string | null;
  readonly binanceMcpUrl: string;
  /**
   * Bearer token for Binance Agent OS. Preferred over the API key when set.
   *
   * Thirty-day lifetime, no refresh grant. Orders placed with it land in the
   * Agentic sub-account, which has no withdrawal scope at all.
   */
  readonly binanceMcpToken: string | null;
  /** Null means market data only: Kertel can price, but cannot see the account or trade. */
  readonly binanceApiKey: string | null;
  readonly binanceApiSecret: string | null;
  readonly model: string | null;
  /**
   * Reasons a pillar is unavailable, in the operator's words.
   *
   * This is what the health tool prints. An empty list means everything the
   * mode needs is present.
   */
  readonly degraded: readonly string[];
};

export type Env = Readonly<Record<string, string | undefined>>;

/** Absent, empty and whitespace-only all mean "not set". */
function present(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseOr(name: string, raw: string | null, schema: z.ZodType<unknown>): unknown {
  if (raw === null) {
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    // Set but wrong. The operator believes something is in force that is not.
    const problem = result.error.issues[0]?.message ?? "is invalid";
    throw new ConfigError(`${name} ${problem}. Fix it or remove it.`);
  }
  return result.data;
}

function railPreferenceOf(raw: string | null): RailPreference {
  if (raw === null) {
    return "auto";
  }
  if (raw === "auto" || raw === "bsc-only" || raw === "base-only") {
    return raw;
  }
  throw new ConfigError(
    `KERTEL_X402_RAIL must be exactly one of auto, bsc-only or base-only. Got ${JSON.stringify(raw)}.`,
  );
}

/**
 * The ranked rail list a preference selects.
 *
 * Exported because `selectPaymentOption` takes the list, not the word, and the
 * mapping is worth testing on its own: `bsc-only` silently falling back to Base
 * would defeat the point of setting it.
 */
export function railsFor(preference: RailPreference): readonly PaymentRail[] {
  switch (preference) {
    case "auto":
      return PAYMENT_RAILS;
    case "bsc-only":
      return PAYMENT_RAILS.filter((rail) => rail.network === "eip155:56");
    case "base-only":
      return PAYMENT_RAILS.filter((rail) => rail.id === "base-usdc");
  }
}

const LOG_LEVELS = ["silent", "error", "warn", "info", "debug", "trace"] as const;

export function loadConfig(env: Env): KertelConfig {
  const degraded: string[] = [];

  const rawMode = present(env["KERTEL_MODE"]);
  if (rawMode !== null && rawMode !== "fixture" && rawMode !== "live") {
    throw new ConfigError(`KERTEL_MODE must be fixture or live. Got ${JSON.stringify(rawMode)}.`);
  }
  const requestedMode: RunMode = rawMode === "live" ? "live" : "fixture";

  const rawLevel = present(env["KERTEL_LOG_LEVEL"]);
  if (rawLevel !== null && !(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    throw new ConfigError(
      `KERTEL_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}. Got ${JSON.stringify(rawLevel)}.`,
    );
  }

  const owner = parseOr("KERTEL_OWNER_WHATSAPP", present(env["KERTEL_OWNER_WHATSAPP"]), e164) as
    | string
    | null;
  if (owner === null) {
    degraded.push(
      "KERTEL_OWNER_WHATSAPP is not set, so Kertel has no owner and refuses every command.",
    );
  }

  const key = parseOr("KERTEL_X402_PRIVATE_KEY", present(env["KERTEL_X402_PRIVATE_KEY"]), privateKey) as
    | string
    | null;
  if (key === null) {
    degraded.push(
      "KERTEL_X402_PRIVATE_KEY is not set, so paid research is unavailable and only the free venue price can be read.",
    );
  }

  // Binance credentials travel as a pair. One without the other is not a
  // partial capability, it is a mistake that would fail at the first signed
  // request, so it is caught here where the operator can see which is missing.
  const binanceKey = present(env["KERTEL_BINANCE_API_KEY"]);
  const binanceSecret = present(env["KERTEL_BINANCE_API_SECRET"]);
  if (binanceKey !== null && binanceSecret === null) {
    throw new ConfigError("KERTEL_BINANCE_API_KEY is set but KERTEL_BINANCE_API_SECRET is not.");
  }
  if (binanceSecret !== null && binanceKey === null) {
    throw new ConfigError("KERTEL_BINANCE_API_SECRET is set but KERTEL_BINANCE_API_KEY is not.");
  }
  const mcpToken = present(env["KERTEL_BINANCE_MCP_TOKEN"]);
  if (binanceKey === null && mcpToken === null) {
    degraded.push(
      "Neither KERTEL_BINANCE_MCP_TOKEN nor KERTEL_BINANCE_API_KEY is set, so Kertel can read prices but cannot see the account or place an order.",
    );
  }
  if (binanceKey !== null && binanceKey === key) {
    // The research wallet spends a few dollars on data. The exchange key can
    // move the trading balance. Sharing one secret between them means a leak of
    // the cheap thing is a leak of the expensive one.
    throw new ConfigError(
      "KERTEL_BINANCE_API_KEY and KERTEL_X402_PRIVATE_KEY must not be the same secret. The research wallet and the trading authority have different blast radii and must be separable.",
    );
  }

  const base = defaultPolicy();

  const allowedSymbols = parseOr("KERTEL_ALLOWED_SYMBOLS", present(env["KERTEL_ALLOWED_SYMBOLS"]), symbols) as
    | string[]
    | null;
  const maxTradeNotional = parseOr("KERTEL_MAX_TRADE_NOTIONAL", present(env["KERTEL_MAX_TRADE_NOTIONAL"]), decimal) as
    | string
    | null;
  const maxDailyLoss = parseOr("KERTEL_MAX_DAILY_LOSS", present(env["KERTEL_MAX_DAILY_LOSS"]), decimal) as
    | string
    | null;
  const maxSlippageBps = parseOr("KERTEL_MAX_SLIPPAGE_BPS", present(env["KERTEL_MAX_SLIPPAGE_BPS"]), integer) as
    | string
    | null;
  const proposalTtl = parseOr("KERTEL_PROPOSAL_TTL_SECONDS", present(env["KERTEL_PROPOSAL_TTL_SECONDS"]), integer) as
    | string
    | null;
  const perCall = parseOr("KERTEL_X402_MAX_PER_CALL_USDC", present(env["KERTEL_X402_MAX_PER_CALL_USDC"]), decimal) as
    | string
    | null;
  const perRun = parseOr("KERTEL_X402_MAX_PER_RUN_USDC", present(env["KERTEL_X402_MAX_PER_RUN_USDC"]), decimal) as
    | string
    | null;
  const perDay = parseOr("KERTEL_X402_MAX_PER_DAY_USDC", present(env["KERTEL_X402_MAX_PER_DAY_USDC"]), decimal) as
    | string
    | null;

  // The live write gate is the one flag that must be exactly "true". Anything
  // else, including a well-meant "yes" or "1", leaves execution off — an
  // ambiguous value here is not permission.
  const liveExecutionRaw = present(env["KERTEL_LIVE_EXECUTION"]);
  const liveExecutionEnabled = liveExecutionRaw === "true";
  if (liveExecutionRaw !== null && liveExecutionRaw !== "true" && liveExecutionRaw !== "false") {
    throw new ConfigError(
      `KERTEL_LIVE_EXECUTION must be exactly "true" or "false". Got ${JSON.stringify(liveExecutionRaw)}. An ambiguous value is not permission to trade.`,
    );
  }

  const policy: Policy = {
    ...base,
    trading: {
      ...base.trading,
      ...(allowedSymbols === null
        ? {}
        : { allowedSymbols: allowedSymbols as readonly string[] as readonly Symbol_[] }),
      ...(maxTradeNotional === null ? {} : { maxTradeNotional: fp.parse(maxTradeNotional) }),
      ...(maxDailyLoss === null ? {} : { maxDailyLoss: fp.parse(maxDailyLoss) }),
      ...(maxSlippageBps === null ? {} : { maxSlippageBps: Number(maxSlippageBps) }),
      ...(proposalTtl === null ? {} : { proposalTtl: seconds(Number(proposalTtl)) }),
      liveExecutionEnabled,
    },
    x402: {
      ...base.x402,
      ...(perCall === null ? {} : { maxPerCallUsdc: fp.parse(perCall) }),
      ...(perRun === null ? {} : { maxPerRunUsdc: fp.parse(perRun) }),
      ...(perDay === null ? {} : { maxPerDayUsdc: fp.parse(perDay) }),
    },
  };

  // A policy that cannot be enforced is worse than no policy, because it reads
  // like protection. `validatePolicy` throws a defect listing every problem at
  // once; here that is not a bug in Kertel but a mistake in the operator's
  // environment, so it is re-raised as the error the operator can act on.
  try {
    validatePolicy(policy);
  } catch (cause) {
    throw new ConfigError(
      `The configured limits are not usable. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Live mode is a claim about what Kertel can do. If the things live mode
  // needs are missing, it stays in fixture mode and says why, rather than
  // presenting saved data as real.
  let mode = requestedMode;
  if (requestedMode === "live" && key === null) {
    mode = "fixture";
    degraded.push(
      "KERTEL_MODE=live was requested but no research wallet is configured, so Kertel stayed in fixture mode.",
    );
  }
  if (requestedMode === "live" && owner === null) {
    mode = "fixture";
    degraded.push(
      "KERTEL_MODE=live was requested but no owner is configured, so Kertel stayed in fixture mode.",
    );
  }

  if (liveExecutionEnabled && mode !== "live") {
    degraded.push(
      "KERTEL_LIVE_EXECUTION=true has no effect while Kertel is in fixture mode; no order can be placed.",
    );
  }

  return {
    mode,
    dataDir: present(env["KERTEL_DATA_DIR"]) ?? "./data",
    logLevel: (rawLevel ?? "info") as KertelConfig["logLevel"],
    ownerWhatsApp: owner,
    // Derived from the owner rather than configured: one fewer secret to
    // manage, and it changes if the owner does, which is the correct blast
    // radius for a hash that only has to be unique per deployment.
    senderSalt: `kertel:${owner ?? "no-owner"}`,
    policy,
    railPreference: railPreferenceOf(present(env["KERTEL_X402_RAIL"])),
    x402PrivateKey: key,
    binanceMcpUrl: present(env["KERTEL_BINANCE_MCP_URL"]) ?? "https://agent.binance.com/mcp/agentic",
    binanceMcpToken: present(env["KERTEL_BINANCE_MCP_TOKEN"]),
    binanceApiKey: binanceKey,
    binanceApiSecret: binanceSecret,
    model: present(env["KERTEL_MODEL"]),
    degraded,
  };
}
