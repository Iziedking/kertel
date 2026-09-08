import { describe, expect, it } from "vitest";
import * as fp from "@telt/core/money";
import { aggregateRisk } from "../src/risk.js";

const q = (value: string) => fp.parse(value);

describe("aggregate account risk", () => {
  it("sums multiple symbols and refuses a breached ceiling", () => {
    const result = aggregateRisk({
      positions: [
        { symbol: "BTCUSDT", spotNotional: q("30"), hedgeNotional: q("28") },
        { symbol: "SOLUSDT", spotNotional: q("25"), hedgeNotional: q("20") },
      ],
      maxTotalExposure: q("50"),
      maxTotalHedgeNotional: q("60"),
    });
    expect(result.allowed).toBe(false);
    expect(result.totalExposure).toEqual(q("55"));
    expect(result.totalHedgeNotional).toEqual(q("48"));
  });

  it("refuses when one protected symbol could not be read", () => {
    const result = aggregateRisk({
      positions: [{ symbol: "BTCUSDT", spotNotional: q("30"), hedgeNotional: q("28") }],
      maxTotalExposure: q("50"),
      maxTotalHedgeNotional: q("50"),
      complete: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("unknown");
  });
});
