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
 * **A variable that is set but wrong is a hard error.** `TELT_MAX_TRADE_NOTIONAL=fifty`
 * is not a disabled feature, it is an operator who believes a limit is in force
 * that is not. That must be caught at boot, not at the moment an order is
 * sized.
 *
 * The distinction is the whole of the design: absent means off, present means
 * it must parse.
 */

import { z } from "zod";

import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import { seconds } from "@telt/core/domain";
import type { RunMode, Symbol_ } from "@telt/core/domain";
import { defaultPolicy, validatePolicy } from "@telt/core/policy";
import type { Policy } from "@telt/core/policy";
import { PAYMENT_RAILS } from "@telt/x402";
import type { PaymentRail } from "@telt/x402";

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

export type TeltConfig = {
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
  /** Null means market data only: Telt can price, but cannot see the account or trade. */
  readonly binanceApiKey: string | null;
  readonly binanceApiSecret: string | null;
  /**
   * Ceiling on futures leverage. Binance defaults to 20x, where an ordinary
   * day's move is the whole margin, so Telt caps it well below that.
   */
  readonly maxLeverage: number;
  /**
   * Ceiling on a futures *position*, not on the margin behind it. Leverage means
   * a small margin controls a large position, so the spot per-trade cap does
   * not bound this risk.
   */
  readonly maxFuturesNotional: FixedPoint;
  readonly model: string | null;
  /**
   * The key for Telt's own reasoning layer.
   *
   * Only the daemon needs it, and only for hunting: with a human present the
   * client's model does the reasoning and Telt never calls one itself. Absent,
   * everything works except acting on an opportunity nobody asked about.
   */
  readonly anthropicApiKey: string | null;
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

/**
 * Read a setting, accepting the name this project used before it was Telt.
 *
 * An operator upgrading an existing install has a file full of `KERTEL_*`.
 * Silently ignoring those would not fail loudly — it would start a server with
 * no trading limits and no owner, which is the worst possible way to be wrong
 * about configuration. So the old name still works, and the new one wins when
 * both are set.
 */
function setting(env: Env, name: string): string | null {
  const current = present(env[`TELT_${name}`]);
  if (current !== null) return current;
  return present(env[`KERTEL_${name}`]);
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
    `TELT_X402_RAIL must be exactly one of auto, bsc-only or base-only. Got ${JSON.stringify(raw)}.`,
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

export function loadConfig(env: Env): TeltConfig {
  const degraded: string[] = [];

  const rawMode = setting(env, "MODE");
  if (rawMode !== null && rawMode !== "fixture" && rawMode !== "live") {
    throw new ConfigError(`TELT_MODE must be fixture or live. Got ${JSON.stringify(rawMode)}.`);
  }
  const requestedMode: RunMode = rawMode === "live" ? "live" : "fixture";

  const rawLevel = setting(env, "LOG_LEVEL");
  if (rawLevel !== null && !(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    throw new ConfigError(
      `TELT_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}. Got ${JSON.stringify(rawLevel)}.`,
    );
  }

  const owner = parseOr("TELT_OWNER_WHATSAPP", setting(env, "OWNER_WHATSAPP"), e164) as
    | string
    | null;
  if (owner === null) {
    degraded.push(
      "TELT_OWNER_WHATSAPP is not set, so Telt has no owner and refuses every command.",
    );
  }

  const key = parseOr("TELT_X402_PRIVATE_KEY", setting(env, "X402_PRIVATE_KEY"), privateKey) as
    | string
    | null;
  if (key === null) {
    degraded.push(
      "TELT_X402_PRIVATE_KEY is not set, so paid research is unavailable and only the free venue price can be read.",
    );
  }

  // Binance credentials travel as a pair. One without the other is not a
  // partial capability, it is a mistake that would fail at the first signed
  // request, so it is caught here where the operator can see which is missing.
  const binanceKey = setting(env, "BINANCE_API_KEY");
  const binanceSecret = setting(env, "BINANCE_API_SECRET");
  if (binanceKey !== null && binanceSecret === null) {
    throw new ConfigError("TELT_BINANCE_API_KEY is set but TELT_BINANCE_API_SECRET is not.");
  }
  if (binanceSecret !== null && binanceKey === null) {
    throw new ConfigError("TELT_BINANCE_API_SECRET is set but TELT_BINANCE_API_KEY is not.");
  }
  const mcpToken = setting(env, "BINANCE_MCP_TOKEN");
  if (binanceKey === null && mcpToken === null) {
    degraded.push(
      "Neither TELT_BINANCE_MCP_TOKEN nor TELT_BINANCE_API_KEY is set, so Telt can read prices but cannot see the account or place an order.",
    );
  }
  if (binanceKey !== null && binanceKey === key) {
    // The research wallet spends a few dollars on data. The exchange key can
    // move the trading balance. Sharing one secret between them means a leak of
    // the cheap thing is a leak of the expensive one.
    throw new ConfigError(
      "TELT_BINANCE_API_KEY and TELT_X402_PRIVATE_KEY must not be the same secret. The research wallet and the trading authority have different blast radii and must be separable.",
    );
  }

  const maxLeverageRaw = parseOr("TELT_MAX_LEVERAGE", setting(env, "MAX_LEVERAGE"), integer) as
    | string
    | null;
  const maxLeverage = maxLeverageRaw === null ? 3 : Number(maxLeverageRaw);
  if (maxLeverage < 1 || maxLeverage > 20) {
    throw new ConfigError(
      `TELT_MAX_LEVERAGE must be between 1 and 20. Got ${String(maxLeverage)}. Above 20x an ordinary day's move is more than the whole margin.`,
    );
  }
  const maxFuturesRaw = parseOr(
    "TELT_MAX_FUTURES_NOTIONAL",
    setting(env, "MAX_FUTURES_NOTIONAL"),
    decimal,
  ) as string | null;

  const base = defaultPolicy();

  const allowedSymbols = parseOr("TELT_ALLOWED_SYMBOLS", setting(env, "ALLOWED_SYMBOLS"), symbols) as
    | string[]
    | null;
  const maxTradeNotional = parseOr("TELT_MAX_TRADE_NOTIONAL", setting(env, "MAX_TRADE_NOTIONAL"), decimal) as
    | string
    | null;
  const maxDailyLoss = parseOr("TELT_MAX_DAILY_LOSS", setting(env, "MAX_DAILY_LOSS"), decimal) as
    | string
    | null;
  const maxSlippageBps = parseOr("TELT_MAX_SLIPPAGE_BPS", setting(env, "MAX_SLIPPAGE_BPS"), integer) as
    | string
    | null;
  const proposalTtl = parseOr("TELT_PROPOSAL_TTL_SECONDS", setting(env, "PROPOSAL_TTL_SECONDS"), integer) as
    | string
    | null;
  const perCall = parseOr("TELT_X402_MAX_PER_CALL_USDC", setting(env, "X402_MAX_PER_CALL_USDC"), decimal) as
    | string
    | null;
  const perRun = parseOr("TELT_X402_MAX_PER_RUN_USDC", setting(env, "X402_MAX_PER_RUN_USDC"), decimal) as
    | string
    | null;
  const perDay = parseOr("TELT_X402_MAX_PER_DAY_USDC", setting(env, "X402_MAX_PER_DAY_USDC"), decimal) as
    | string
    | null;

  // The live write gate is the one flag that must be exactly "true". Anything
  // else, including a well-meant "yes" or "1", leaves execution off — an
  // ambiguous value here is not permission.
  const liveExecutionRaw = setting(env, "LIVE_EXECUTION");
  const liveExecutionEnabled = liveExecutionRaw === "true";
  if (liveExecutionRaw !== null && liveExecutionRaw !== "true" && liveExecutionRaw !== "false") {
    throw new ConfigError(
      `TELT_LIVE_EXECUTION must be exactly "true" or "false". Got ${JSON.stringify(liveExecutionRaw)}. An ambiguous value is not permission to trade.`,
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
  // once; here that is not a bug in Telt but a mistake in the operator's
  // environment, so it is re-raised as the error the operator can act on.
  try {
    validatePolicy(policy);
  } catch (cause) {
    throw new ConfigError(
      `The configured limits are not usable. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Live mode is a claim about what Telt can do. If the things live mode
  // needs are missing, it stays in fixture mode and says why, rather than
  // presenting saved data as real.
  let mode = requestedMode;
  if (requestedMode === "live" && key === null) {
    mode = "fixture";
    degraded.push(
      "TELT_MODE=live was requested but no research wallet is configured, so Telt stayed in fixture mode.",
    );
  }
  if (requestedMode === "live" && owner === null) {
    mode = "fixture";
    degraded.push(
      "TELT_MODE=live was requested but no owner is configured, so Telt stayed in fixture mode.",
    );
  }

  if (liveExecutionEnabled && mode !== "live") {
    degraded.push(
      "TELT_LIVE_EXECUTION=true has no effect while Telt is in fixture mode; no order can be placed.",
    );
  }

  return {
    mode,
    dataDir: setting(env, "DATA_DIR") ?? "./data",
    logLevel: (rawLevel ?? "info") as TeltConfig["logLevel"],
    ownerWhatsApp: owner,
    // Derived from the owner rather than configured: one fewer secret to
    // manage, and it changes if the owner does, which is the correct blast
    // radius for a hash that only has to be unique per deployment.
    senderSalt: `telt:${owner ?? "no-owner"}`,
    policy,
    railPreference: railPreferenceOf(setting(env, "X402_RAIL")),
    x402PrivateKey: key,
    binanceMcpUrl: setting(env, "BINANCE_MCP_URL") ?? "https://agent.binance.com/mcp/agentic",
    binanceMcpToken: setting(env, "BINANCE_MCP_TOKEN"),
    binanceApiKey: binanceKey,
    binanceApiSecret: binanceSecret,
    maxLeverage,
    maxFuturesNotional: fp.parse(maxFuturesRaw ?? "50.00"),
    model: setting(env, "MODEL"),
    // Not TELT_-prefixed: it is Anthropic's own conventional name, and an
    // operator who already has it exported should not have to copy it.
    anthropicApiKey: present(env["ANTHROPIC_API_KEY"]),
    degraded,
  };
}
