import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";

import { ConfigError, loadConfig, railsFor } from "../src/infra/config.js";

const KEY = `0x${"a".repeat(64)}`;
const OWNER = "+2348067053854";
const BINANCE = { TELT_BINANCE_API_KEY: "binance-key", TELT_BINANCE_API_SECRET: "binance-secret" };

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { TELT_OWNER_WHATSAPP: OWNER, TELT_X402_PRIVATE_KEY: KEY, ...overrides };
}

/**
 * The distinction this file exists to protect: absent means a feature is off
 * and says so; present-but-wrong means an operator believes something is in
 * force that is not, and that has to fail at boot.
 */
describe("an unset variable disables one thing loudly", () => {
  it("runs with nothing configured at all", () => {
    const config = loadConfig({});
    expect(config.mode).toBe("fixture");
    expect(config.ownerWhatsApp).toBeNull();
    expect(config.x402PrivateKey).toBeNull();
    expect(config.degraded.join(" ")).toContain("TELT_OWNER_WHATSAPP");
    expect(config.degraded.join(" ")).toContain("TELT_X402_PRIVATE_KEY");
  });

  it("treats an empty string the same as absent", () => {
    const config = loadConfig({ TELT_OWNER_WHATSAPP: "   ", TELT_X402_PRIVATE_KEY: "" });
    expect(config.ownerWhatsApp).toBeNull();
    expect(config.x402PrivateKey).toBeNull();
  });

  it("keeps the default limits when none are given", () => {
    const config = loadConfig(env());
    expect(fp.format(config.policy.trading.maxTradeNotional)).toBe("25.00");
    expect(fp.format(config.policy.x402.maxPerDayUsdc)).toBe("2.00");
  });
});

describe("a variable that is set but wrong is a hard error", () => {
  it("refuses a limit that is not a number", () => {
    expect(() => loadConfig(env({ TELT_MAX_TRADE_NOTIONAL: "fifty" }))).toThrow(ConfigError);
  });

  it("refuses a phone number that is not E.164", () => {
    expect(() => loadConfig(env({ TELT_OWNER_WHATSAPP: "08067053854" }))).toThrow(ConfigError);
  });

  it("refuses a private key of the wrong shape", () => {
    expect(() => loadConfig(env({ TELT_X402_PRIVATE_KEY: "0xnope" }))).toThrow(ConfigError);
  });

  it("refuses an unknown mode rather than falling back to fixture", () => {
    // Falling back would be friendlier and would hide the fact that somebody
    // typed "production" and believes they are in it.
    expect(() => loadConfig(env({ TELT_MODE: "production" }))).toThrow(ConfigError);
  });

  it("refuses an unknown rail preference", () => {
    expect(() => loadConfig(env({ TELT_X402_RAIL: "bsc" }))).toThrow(ConfigError);
  });

  it("names the variable in the message, so the operator knows what to fix", () => {
    try {
      loadConfig(env({ TELT_MAX_SLIPPAGE_BPS: "half a percent" }));
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect((cause as Error).message).toContain("TELT_MAX_SLIPPAGE_BPS");
    }
  });

  it("refuses limits that cannot be enforced together", () => {
    // A per-call cap above the per-run cap is not a tighter limit, it is an
    // incoherent one, and it reads like protection.
    expect(() =>
      loadConfig(env({ TELT_X402_MAX_PER_CALL_USDC: "5.00", TELT_X402_MAX_PER_RUN_USDC: "0.10" })),
    ).toThrow(ConfigError);
  });
});

describe("the live write gate", () => {
  it("is off when unset, and when explicitly false", () => {
    expect(loadConfig(env({ TELT_MODE: "live" })).policy.trading.liveExecutionEnabled).toBe(false);
    expect(
      loadConfig(env({ TELT_LIVE_EXECUTION: "false", TELT_MODE: "live" })).policy.trading
        .liveExecutionEnabled,
    ).toBe(false);
  });

  it("rejects every near-miss outright, because none of them is permission to trade", () => {
    // Not silently treated as false. Somebody who wrote "yes" believes trading
    // is on, and the gap between that belief and the truth is the whole risk.
    for (const value of ["yes", "1", "TRUE", "True", "on", "maybe"]) {
      expect(() => loadConfig(env({ TELT_LIVE_EXECUTION: value })), value).toThrow(ConfigError);
    }
  });

  it("turns on only for the exact word", () => {
    const config = loadConfig(env({ TELT_LIVE_EXECUTION: "true", TELT_MODE: "live" }));
    expect(config.policy.trading.liveExecutionEnabled).toBe(true);
  });

  it("tolerates surrounding whitespace, which .env files add without asking", () => {
    const config = loadConfig(env({ TELT_LIVE_EXECUTION: "  true  ", TELT_MODE: "live" }));
    expect(config.policy.trading.liveExecutionEnabled).toBe(true);
  });
});

describe("live mode is a claim that has to be backed", () => {
  it("stays in fixture mode when live is asked for with no wallet", () => {
    const config = loadConfig({ TELT_MODE: "live", TELT_OWNER_WHATSAPP: OWNER });
    expect(config.mode).toBe("fixture");
    expect(config.degraded.join(" ")).toContain("stayed in fixture mode");
  });

  it("stays in fixture mode when live is asked for with no owner", () => {
    const config = loadConfig({ TELT_MODE: "live", TELT_X402_PRIVATE_KEY: KEY });
    expect(config.mode).toBe("fixture");
  });

  it("goes live when everything live mode needs is present", () => {
    const config = loadConfig(env({ TELT_MODE: "live", ...BINANCE }));
    expect(config.mode).toBe("live");
    expect(config.degraded).toHaveLength(0);
  });

  it("still goes live without exchange credentials, but says trading is off", () => {
    // Research and trading are separate capabilities. Missing one should not
    // disable the other, it should be reported.
    const config = loadConfig(env({ TELT_MODE: "live" }));
    expect(config.mode).toBe("live");
    expect(config.degraded.join(" ")).toContain("cannot see the account or place an order");
  });

  it("says plainly that the execution flag does nothing in fixture mode", () => {
    const config = loadConfig({ TELT_LIVE_EXECUTION: "true" });
    expect(config.degraded.join(" ")).toContain("no effect while Telt is in fixture mode");
  });
});

describe("exchange credentials", () => {
  it("refuses a key without its secret, and a secret without its key", () => {
    expect(() => loadConfig(env({ TELT_BINANCE_API_KEY: "k" }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ TELT_BINANCE_API_SECRET: "s" }))).toThrow(ConfigError);
  });

  it("refuses to let the research wallet and the trading authority share one secret", () => {
    // The research wallet spends a few dollars on data. The exchange key can
    // move the trading balance. One leak must not be both.
    expect(() =>
      loadConfig(env({ TELT_BINANCE_API_KEY: KEY, TELT_BINANCE_API_SECRET: "s" })),
    ).toThrow(ConfigError);
  });

  it("carries both through when they are a distinct pair", () => {
    const config = loadConfig(env(BINANCE));
    expect(config.binanceApiKey).toBe("binance-key");
    expect(config.binanceApiSecret).toBe("binance-secret");
  });
});

describe("rail preference", () => {
  it("defaults to the full ranked list, Binance's own rail first", () => {
    expect(railsFor("auto").map((rail) => rail.id)).toEqual(["bsc-u", "bsc-usd1", "base-usdc"]);
  });

  it("bsc-only really excludes Base, rather than quietly falling back to it", () => {
    // The whole point of setting it is to refuse providers that do not take
    // Binance's rail. A silent fallback would defeat that.
    expect(railsFor("bsc-only").map((rail) => rail.id)).toEqual(["bsc-u", "bsc-usd1"]);
  });

  it("base-only is exactly one rail", () => {
    expect(railsFor("base-only").map((rail) => rail.id)).toEqual(["base-usdc"]);
  });
});

describe("the sender salt", () => {
  it("differs per owner, so two deployments cannot be cross-referenced by hash", () => {
    const first = loadConfig(env({ TELT_OWNER_WHATSAPP: "+2348067053854" }));
    const second = loadConfig(env({ TELT_OWNER_WHATSAPP: "+2348130118673" }));
    expect(first.senderSalt).not.toBe(second.senderSalt);
  });
});
