import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";

import { decimalFromJson, positiveDecimalFromJson } from "../src/decimal.js";

/**
 * The conversion from a provider's JSON number to a decimal string is the one
 * place a price can change value without anybody editing it. These tests are
 * about the digits, not the type.
 */
describe("decimalFromJson", () => {
  it("keeps the digits a provider actually sent", () => {
    expect(decimalFromJson(2505.66)).toBe("2505.66");
    expect(decimalFromJson(67187.34)).toBe("67187.34");
    expect(decimalFromJson(0.5)).toBe("0.5");
    expect(decimalFromJson(-3.25)).toBe("-3.25");
    expect(decimalFromJson(0)).toBe("0");
  });

  it("passes an exchange's own precision through untouched", () => {
    // Binance states its precision with trailing zeros. Round-tripping that
    // through a double would silently throw the statement away.
    expect(decimalFromJson("2505.66000000")).toBe("2505.66000000");
    expect(decimalFromJson("  0.00010000  ")).toBe("0.00010000");
  });

  it("expands exponent notation rather than refusing a small unit price", () => {
    // String(1e-7) is "1e-7". A token that genuinely trades there must survive.
    expect(decimalFromJson(1e-7)).toBe("0.0000001");
    expect(decimalFromJson(0.00000012)).toBe("0.00000012");
    expect(decimalFromJson("1.5e-8")).toBe("0.000000015");
    expect(decimalFromJson("-2.5e-3")).toBe("-0.0025");
    expect(decimalFromJson("3e2")).toBe("300");
  });

  it("produces something the money layer accepts", () => {
    for (const value of [2505.66, 1e-7, 0.00000012, 1317802988326.25]) {
      const decimal = decimalFromJson(value);
      expect(decimal).not.toBeNull();
      expect(() => fp.parse(decimal as string)).not.toThrow();
    }
  });

  it("refuses anything that is not a number it can vouch for", () => {
    expect(decimalFromJson(Number.NaN)).toBeNull();
    expect(decimalFromJson(Number.POSITIVE_INFINITY)).toBeNull();
    expect(decimalFromJson(null)).toBeNull();
    expect(decimalFromJson(undefined)).toBeNull();
    expect(decimalFromJson({})).toBeNull();
    expect(decimalFromJson([])).toBeNull();
    expect(decimalFromJson(true)).toBeNull();
    expect(decimalFromJson("not a number")).toBeNull();
    expect(decimalFromJson("")).toBeNull();
    // Past the safe integer range the digits belong to the double, not to the
    // provider, so there is nothing honest to report.
    expect(decimalFromJson(1e21)).toBeNull();
  });
});

describe("positiveDecimalFromJson", () => {
  it("accepts a real price", () => {
    expect(positiveDecimalFromJson(2505.66)).toBe("2505.66");
    expect(positiveDecimalFromJson("0.00000001")).toBe("0.00000001");
  });

  it("refuses zero and negatives, which sizing code would divide by", () => {
    expect(positiveDecimalFromJson(0)).toBeNull();
    expect(positiveDecimalFromJson("0.00")).toBeNull();
    expect(positiveDecimalFromJson(-1)).toBeNull();
    expect(positiveDecimalFromJson("-0.5")).toBeNull();
  });
});
