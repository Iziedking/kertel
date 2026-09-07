import { describe, expect, it } from "vitest";

import * as fp from "../src/money/fixed-point.js";

/**
 * Every expected value here was worked out by hand. Where a case exists because
 * a real system would get it wrong, the test says which system and how.
 */

describe("parse", () => {
  it("keeps the scale written in the string", () => {
    expect(fp.parse("1.50")).toEqual({ atoms: 150n, scale: 2 });
    expect(fp.parse("1.5")).toEqual({ atoms: 15n, scale: 1 });
    expect(fp.parse("0")).toEqual({ atoms: 0n, scale: 0 });
    expect(fp.parse("-0.001")).toEqual({ atoms: -1n, scale: 3 });
  });

  it("round-trips through format without changing the text", () => {
    for (const literal of ["0", "1.50", "-0.001", "123456789.123456789", "-42"]) {
      expect(fp.format(fp.parse(literal))).toBe(literal);
    }
  });

  it("carries values a double cannot hold", () => {
    // 2 ** 53 + 1 is the first integer a JS number cannot represent. A balance
    // in wei or a USDT quantity on a cheap token reaches this range easily.
    const big = "9007199254740993";
    expect(fp.format(fp.parse(big))).toBe(big);
  });

  it("refuses anything that is not a plain decimal literal", () => {
    // Exponent form is the one that matters: several APIs emit 1e-8 for a small
    // quantity, and Number() would happily accept it while the exchange filter
    // and the audit trail expect a written-out decimal.
    for (const bad of ["1e-8", "1E5", "+1", " 1", "1 ", "", ".5", "1.", "01", "NaN", "Infinity", "1_000", "0x10"]) {
      expect(() => fp.parse(bad), bad).toThrow(fp.FixedPointError);
    }
  });

  it("refuses a lossy explicit scale instead of rounding it away", () => {
    expect(() => fp.parse("1.005", 2)).toThrow(/would lose precision/);
    expect(fp.parse("1.500", 2)).toEqual({ atoms: 150n, scale: 2 });
  });
});

describe("addition and subtraction", () => {
  it("gets the case IEEE 754 famously gets wrong", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as doubles.
    expect(fp.format(fp.add(fp.parse("0.1"), fp.parse("0.2")))).toBe("0.3");
    expect(fp.equals(fp.add(fp.parse("0.1"), fp.parse("0.2")), fp.parse("0.3"))).toBe(true);
  });

  it("aligns operands to the wider scale rather than truncating one", () => {
    expect(fp.format(fp.add(fp.parse("1.5"), fp.parse("0.005")))).toBe("1.505");
    expect(fp.format(fp.subtract(fp.parse("1"), fp.parse("0.000001")))).toBe("0.999999");
  });
});

describe("multiply", () => {
  it("is exact, and its scale is the sum of the operand scales", () => {
    // 25 USDC of ETH at 2431.17 is 60779.25 in raw product terms; the point of
    // an exact product is that the fee and slippage steps that follow start
    // from a number nobody has rounded yet.
    const product = fp.multiply(fp.parse("2431.17"), fp.parse("0.0102"));
    expect(product.scale).toBe(6);
    expect(fp.format(product)).toBe("24.797934");
  });

  it("keeps a fee calculation honest at eight decimals", () => {
    const notional = fp.parse("25.00");
    const feeRate = fp.parse("0.001");
    expect(fp.format(fp.multiply(notional, feeRate))).toBe("0.02500");
  });
});

describe("divide", () => {
  it("makes the caller choose the scale and the direction", () => {
    // Sizing an order: 25 USDC at 2431.17 per ETH. The exact quotient is
    // 0.01028311471..., so the eighth decimal is where the direction shows.
    // Floor, because rounding the quantity up spends more than the user
    // approved, and the difference compounds across every run.
    const quantity = fp.divide(fp.parse("25.00"), fp.parse("2431.17"), 8, "floor");
    expect(fp.format(quantity)).toBe("0.01028311");

    const roundedUp = fp.divide(fp.parse("25.00"), fp.parse("2431.17"), 8, "ceil");
    expect(fp.format(roundedUp)).toBe("0.01028312");
  });

  it("rounds negatives in the named direction, not toward zero", () => {
    // BigInt division truncates toward zero, so -7n / 2n is -3n. Floor must be
    // -4. A loss figure floored the wrong way understates the loss.
    expect(fp.format(fp.divide(fp.parse("-7"), fp.parse("2"), 0, "floor"))).toBe("-4");
    expect(fp.format(fp.divide(fp.parse("-7"), fp.parse("2"), 0, "ceil"))).toBe("-3");
    expect(fp.format(fp.divide(fp.parse("-7"), fp.parse("2"), 0, "trunc"))).toBe("-3");
  });

  it("refuses division by zero", () => {
    expect(() => fp.divide(fp.parse("1"), fp.parse("0"), 2, "floor")).toThrow(fp.FixedPointError);
  });
});

describe("floorToStep", () => {
  it("snaps a quantity down to the exchange step size", () => {
    // Binance ETHUSDT spot uses a 0.0001 LOT_SIZE step. An order that is not a
    // whole number of steps is rejected outright.
    const step = fp.parse("0.0001");
    expect(fp.format(fp.floorToStep(fp.parse("0.01028306"), step))).toBe("0.01020000");
    expect(fp.format(fp.floorToStep(fp.parse("0.0102"), step))).toBe("0.0102");
  });

  it("snaps a price down to the tick size", () => {
    expect(fp.format(fp.floorToStep(fp.parse("2431.17"), fp.parse("0.01")))).toBe("2431.17");
    expect(fp.format(fp.floorToStep(fp.parse("2431.179"), fp.parse("0.01")))).toBe("2431.170");
  });

  it("floors toward negative infinity for a negative value", () => {
    expect(fp.format(fp.floorToStep(fp.parse("-0.00105"), fp.parse("0.0001")))).toBe("-0.00110");
  });

  it("refuses a zero or negative step", () => {
    expect(() => fp.floorToStep(fp.parse("1"), fp.parse("0"))).toThrow(fp.FixedPointError);
    expect(() => fp.floorToStep(fp.parse("1"), fp.parse("-0.1"))).toThrow(fp.FixedPointError);
  });
});

describe("applyBasisPoints", () => {
  it("computes a slippage allowance at the stated direction", () => {
    // 50 bps of 2431.17 is 12.15585, which is not representable at scale 2.
    // Ceil, because the allowance is a ceiling the user agreed to.
    expect(fp.format(fp.applyBasisPoints(fp.parse("2431.17"), 50, "ceil"))).toBe("12.16");
    expect(fp.format(fp.applyBasisPoints(fp.parse("2431.17"), 50, "floor"))).toBe("12.15");
  });

  it("treats zero basis points as no allowance at all", () => {
    expect(fp.format(fp.applyBasisPoints(fp.parse("2431.17"), 0, "ceil"))).toBe("0.00");
  });

  it("refuses a fractional or negative basis point value", () => {
    expect(() => fp.applyBasisPoints(fp.parse("1"), 0.5, "ceil")).toThrow(fp.FixedPointError);
    expect(() => fp.applyBasisPoints(fp.parse("1"), -1, "ceil")).toThrow(fp.FixedPointError);
  });
});

describe("compare", () => {
  it("compares across different scales without rescaling the inputs", () => {
    expect(fp.equals(fp.parse("1.5"), fp.parse("1.50"))).toBe(true);
    expect(fp.lessThan(fp.parse("1.4999"), fp.parse("1.5"))).toBe(true);
    expect(fp.greaterThan(fp.parse("1.5001"), fp.parse("1.5"))).toBe(true);
  });

  it("orders negatives correctly", () => {
    expect(fp.lessThan(fp.parse("-2"), fp.parse("-1"))).toBe(true);
    expect(fp.format(fp.min(fp.parse("-2"), fp.parse("-1")))).toBe("-2");
    expect(fp.format(fp.max(fp.parse("-2"), fp.parse("-1")))).toBe("-1");
  });
});

describe("atomic units", () => {
  it("reads a USDC amount straight out of an x402 challenge", () => {
    // The live CoinGecko challenge on Base offers amount "10000" for USDC,
    // which has six decimals. That is one cent, not ten thousand dollars.
    const price = fp.fromAtoms(10_000n, 6);
    expect(fp.format(price)).toBe("0.010000");
    expect(fp.equals(price, fp.parse("0.01"))).toBe(true);
  });

  it("reads the Nansen Smart Money price the same way", () => {
    expect(fp.equals(fp.fromAtoms(50_000n, 6), fp.parse("0.05"))).toBe(true);
  });
});

describe("trim", () => {
  it("drops trailing zeros without changing the value", () => {
    // The case it exists for: one cent arriving at eighteen decimals from a BNB
    // Smart Chain rail, and six from Base. Both are one cent.
    const bsc = fp.fromAtoms(10_000_000_000_000_000n, 18);
    const base = fp.fromAtoms(10_000n, 6);

    expect(fp.format(fp.trim(bsc, 2))).toBe("0.01");
    expect(fp.format(fp.trim(base, 2))).toBe("0.01");
    expect(fp.equals(fp.trim(bsc, 2), bsc)).toBe(true);
    expect(fp.equals(fp.trim(base, 2), base)).toBe(true);
  });

  it("keeps money looking like money", () => {
    // 2 trimmed to "2" is arithmetically right and wrong to read on a receipt.
    expect(fp.format(fp.trim(fp.parse("2.000000"), 2))).toBe("2.00");
    expect(fp.format(fp.trim(fp.parse("0.500000"), 2))).toBe("0.50");
  });

  it("stops at the first significant digit, however deep", () => {
    expect(fp.format(fp.trim(fp.parse("0.000000010000"), 2))).toBe("0.00000001");
    expect(fp.format(fp.trim(fp.parse("1.230000"), 2))).toBe("1.23");
  });

  it("leaves a value that is already at or below the floor alone", () => {
    const cents = fp.parse("0.01");
    expect(fp.trim(cents, 2)).toEqual(cents);
    expect(fp.trim(cents, 6)).toEqual(cents);
  });

  it("handles zero and negatives without losing the sign", () => {
    expect(fp.format(fp.trim(fp.parse("0.000000"), 2))).toBe("0.00");
    expect(fp.format(fp.trim(fp.parse("-1.250000"), 2))).toBe("-1.25");
    expect(fp.format(fp.trim(fp.parse("-0.010000"), 2))).toBe("-0.01");
  });

  it("defaults to trimming all the way down when no floor is given", () => {
    expect(fp.format(fp.trim(fp.parse("2.000000")))).toBe("2");
  });
});
