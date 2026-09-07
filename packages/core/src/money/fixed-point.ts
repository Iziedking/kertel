/**
 * Fixed-point decimal arithmetic for every price, quantity, notional, fee and
 * payment value in Kertel.
 *
 * The second consumer of this module is `scripts/prove.ts`, so it stays pure:
 * no imports, no clock, no environment. That constraint is checkable, which is
 * why it is written down rather than left as a preference.
 *
 * Why not a float, and why not a library:
 *
 * - IEEE 754 cannot represent 0.1, so `0.1 + 0.2 !== 0.3`. A trading system
 *   that rounds a notional the wrong way by one atom either fails an exchange
 *   filter or spends money the user did not approve.
 * - Exchange filters (tick size, step size, minimum notional) and ERC-20 token
 *   amounts are already fixed-point integers. Representing them as anything
 *   else means converting twice and rounding twice.
 * - Rounding direction is a safety decision here, not a formatting detail, so
 *   every operation that can lose precision demands it explicitly. There is no
 *   default rounding mode on purpose.
 *
 * A value is `atoms / 10 ** scale`. `{ atoms: 12345n, scale: 2 }` is 123.45.
 */

/** How a value that cannot be represented exactly is resolved. */
export type Rounding =
  /** Toward negative infinity. The safe direction for anything the user receives. */
  | "floor"
  /** Toward positive infinity. The safe direction for anything the user pays. */
  | "ceil"
  /** Toward zero. Never silently applied; callers ask for it by name. */
  | "trunc";

export type FixedPoint = {
  readonly atoms: bigint;
  readonly scale: number;
};

/** Thrown when a caller hands this module something that is not a number it can trust. */
export class FixedPointError extends Error {
  override readonly name = "FixedPointError";
}

const MAX_SCALE = 38;

/**
 * A plain decimal literal. Deliberately narrow: no exponent, no leading plus,
 * no underscores, no whitespace, no `Infinity`, no `NaN`. If a provider sends
 * `1e-8` we want a loud failure at the boundary, not a silent reinterpretation.
 */
const DECIMAL_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new FixedPointError(
      `scale must be an integer between 0 and ${MAX_SCALE}, received ${String(scale)}`,
    );
  }
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Parse a decimal string. The scale is taken from the string itself unless one
 * is given, so `parse("1.50")` keeps its two decimals and compares equal to
 * `parse("1.5")` without either being rescaled behind the caller's back.
 */
export function parse(input: string, scale?: number): FixedPoint {
  if (typeof input !== "string") {
    throw new FixedPointError(`expected a decimal string, received ${typeof input}`);
  }
  if (!DECIMAL_LITERAL.test(input)) {
    throw new FixedPointError(`not a plain decimal string: ${JSON.stringify(input)}`);
  }

  const negative = input.startsWith("-");
  const unsigned = negative ? input.slice(1) : input;
  const dot = unsigned.indexOf(".");
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);

  const naturalScale = fraction.length;
  assertScale(naturalScale);

  const magnitude = BigInt(whole + fraction);
  const parsed: FixedPoint = {
    atoms: negative ? -magnitude : magnitude,
    scale: naturalScale,
  };

  return scale === undefined ? parsed : rescale(parsed, scale, "trunc", { exactOnly: true });
}

/** Build a value straight from atomic units, the shape chains and exchanges use. */
export function fromAtoms(atoms: bigint, scale: number): FixedPoint {
  assertScale(scale);
  return { atoms, scale };
}

export function zero(scale: number): FixedPoint {
  assertScale(scale);
  return { atoms: 0n, scale };
}

/** Render back to a plain decimal string, always with exactly `scale` decimals. */
export function format(value: FixedPoint): string {
  assertScale(value.scale);
  const negative = value.atoms < 0n;
  const digits = (negative ? -value.atoms : value.atoms).toString();

  if (value.scale === 0) {
    return negative ? `-${digits}` : digits;
  }

  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function divideWithRounding(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) {
    throw new FixedPointError("division by zero");
  }

  // BigInt division truncates toward zero, which is only one of the three
  // behaviours we need. Correct it from the remainder's sign.
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }

  const negative = numerator < 0n !== denominator < 0n;
  switch (rounding) {
    case "trunc":
      return quotient;
    case "floor":
      return negative ? quotient - 1n : quotient;
    case "ceil":
      return negative ? quotient : quotient + 1n;
    default: {
      const never: never = rounding;
      throw new FixedPointError(`unhandled rounding mode ${String(never)}`);
    }
  }
}

/**
 * Move a value to a different scale.
 *
 * `exactOnly` turns a lossy rescale into an error instead of a rounding. Use it
 * wherever losing a digit would mean silently disagreeing with a counterparty:
 * parsing a configured cap, or reading a price out of a provider payload.
 */
export function rescale(
  value: FixedPoint,
  scale: number,
  rounding: Rounding,
  options?: { readonly exactOnly?: boolean },
): FixedPoint {
  assertScale(scale);
  if (scale === value.scale) {
    return value;
  }
  if (scale > value.scale) {
    return { atoms: value.atoms * pow10(scale - value.scale), scale };
  }

  const divisor = pow10(value.scale - scale);
  if (options?.exactOnly === true && value.atoms % divisor !== 0n) {
    throw new FixedPointError(
      `rescaling ${format(value)} to scale ${String(scale)} would lose precision`,
    );
  }
  return { atoms: divideWithRounding(value.atoms, divisor, rounding), scale };
}

/**
 * Drop trailing zero decimals without changing the value.
 *
 * Chains carry money at the token's own decimals: eighteen on BNB Smart Chain,
 * six on Base. That is an encoding detail of the rail, not a property of the
 * price, and letting it survive into the domain means a five-cent research call
 * reads back as `0.050000000000000000` in a WhatsApp receipt, and a sum of one
 * Base call and one BSC call inherits eighteen decimals for no reason.
 *
 * This is exact by construction: it only removes zeros, so the value before and
 * after compare equal. `minScale` keeps money looking like money — trimming
 * `2.00` all the way to `2` would be arithmetically right and wrong to read.
 */
export function trim(value: FixedPoint, minScale = 0): FixedPoint {
  assertScale(minScale);
  if (value.scale <= minScale) {
    return value;
  }
  let atoms = value.atoms;
  let scale = value.scale;
  while (scale > minScale && atoms % 10n === 0n) {
    atoms /= 10n;
    scale -= 1;
  }
  return { atoms, scale };
}

function alignScales(a: FixedPoint, b: FixedPoint): readonly [FixedPoint, FixedPoint] {
  const scale = Math.max(a.scale, b.scale);
  return [rescale(a, scale, "trunc"), rescale(b, scale, "trunc")] as const;
}

export function add(a: FixedPoint, b: FixedPoint): FixedPoint {
  const [left, right] = alignScales(a, b);
  return { atoms: left.atoms + right.atoms, scale: left.scale };
}

export function subtract(a: FixedPoint, b: FixedPoint): FixedPoint {
  const [left, right] = alignScales(a, b);
  return { atoms: left.atoms - right.atoms, scale: left.scale };
}

/** Exact by construction: the product's scale is the sum of the operands' scales. */
export function multiply(a: FixedPoint, b: FixedPoint): FixedPoint {
  const scale = a.scale + b.scale;
  assertScale(scale);
  return { atoms: a.atoms * b.atoms, scale };
}

/**
 * Division always loses precision, so the caller names both the result scale
 * and the direction. Sizing an order is `divide(notional, price, stepScale,
 * "floor")`: never buy more than the budget covers.
 */
export function divide(
  a: FixedPoint,
  b: FixedPoint,
  scale: number,
  rounding: Rounding,
): FixedPoint {
  assertScale(scale);
  if (b.atoms === 0n) {
    throw new FixedPointError("division by zero");
  }
  const numerator = a.atoms * pow10(scale + b.scale);
  const denominator = b.atoms * pow10(a.scale);
  return { atoms: divideWithRounding(numerator, denominator, rounding), scale };
}

export function compare(a: FixedPoint, b: FixedPoint): -1 | 0 | 1 {
  const [left, right] = alignScales(a, b);
  if (left.atoms < right.atoms) return -1;
  if (left.atoms > right.atoms) return 1;
  return 0;
}

export function equals(a: FixedPoint, b: FixedPoint): boolean {
  return compare(a, b) === 0;
}

export function lessThan(a: FixedPoint, b: FixedPoint): boolean {
  return compare(a, b) === -1;
}

export function greaterThan(a: FixedPoint, b: FixedPoint): boolean {
  return compare(a, b) === 1;
}

export function isZero(value: FixedPoint): boolean {
  return value.atoms === 0n;
}

export function isNegative(value: FixedPoint): boolean {
  return value.atoms < 0n;
}

export function isPositive(value: FixedPoint): boolean {
  return value.atoms > 0n;
}

export function negate(value: FixedPoint): FixedPoint {
  return { atoms: -value.atoms, scale: value.scale };
}

export function abs(value: FixedPoint): FixedPoint {
  return value.atoms < 0n ? negate(value) : value;
}

export function min(a: FixedPoint, b: FixedPoint): FixedPoint {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: FixedPoint, b: FixedPoint): FixedPoint {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Snap a value down to a multiple of `step`.
 *
 * This is the exchange `stepSize` and `tickSize` rule. Rounding down rather than
 * to nearest matters: a quantity rounded up can exceed the approved notional,
 * and a buy price rounded up pays more than the user confirmed.
 */
export function floorToStep(value: FixedPoint, step: FixedPoint): FixedPoint {
  if (!isPositive(step)) {
    throw new FixedPointError(`step must be positive, received ${format(step)}`);
  }
  const [aligned, alignedStep] = alignScales(value, step);
  const multiples = divideWithRounding(aligned.atoms, alignedStep.atoms, "floor");
  return { atoms: multiples * alignedStep.atoms, scale: aligned.scale };
}

/**
 * Basis points, the unit every slippage and fee limit in this system is
 * expressed in. 100 bps is one percent. Integer input only, because a
 * fractional basis point in a configured limit is a typo.
 */
export function applyBasisPoints(value: FixedPoint, bps: number, rounding: Rounding): FixedPoint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new FixedPointError(`basis points must be a non-negative integer, received ${String(bps)}`);
  }
  const numerator = value.atoms * BigInt(bps);
  return { atoms: divideWithRounding(numerator, 10_000n, rounding), scale: value.scale };
}
