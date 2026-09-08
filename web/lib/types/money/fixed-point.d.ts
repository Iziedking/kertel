/**
 * Fixed-point decimal arithmetic for every price, quantity, notional, fee and
 * payment value in Telt.
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
"floor"
/** Toward positive infinity. The safe direction for anything the user pays. */
 | "ceil"
/** Toward zero. Never silently applied; callers ask for it by name. */
 | "trunc";
export type FixedPoint = {
    readonly atoms: bigint;
    readonly scale: number;
};
/** Thrown when a caller hands this module something that is not a number it can trust. */
export declare class FixedPointError extends Error {
    readonly name = "FixedPointError";
}
/**
 * Parse a decimal string. The scale is taken from the string itself unless one
 * is given, so `parse("1.50")` keeps its two decimals and compares equal to
 * `parse("1.5")` without either being rescaled behind the caller's back.
 */
export declare function parse(input: string, scale?: number): FixedPoint;
/** Build a value straight from atomic units, the shape chains and exchanges use. */
export declare function fromAtoms(atoms: bigint, scale: number): FixedPoint;
export declare function zero(scale: number): FixedPoint;
/** Render back to a plain decimal string, always with exactly `scale` decimals. */
export declare function format(value: FixedPoint): string;
/**
 * Move a value to a different scale.
 *
 * `exactOnly` turns a lossy rescale into an error instead of a rounding. Use it
 * wherever losing a digit would mean silently disagreeing with a counterparty:
 * parsing a configured cap, or reading a price out of a provider payload.
 */
export declare function rescale(value: FixedPoint, scale: number, rounding: Rounding, options?: {
    readonly exactOnly?: boolean;
}): FixedPoint;
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
export declare function trim(value: FixedPoint, minScale?: number): FixedPoint;
export declare function add(a: FixedPoint, b: FixedPoint): FixedPoint;
export declare function subtract(a: FixedPoint, b: FixedPoint): FixedPoint;
/** Exact by construction: the product's scale is the sum of the operands' scales. */
export declare function multiply(a: FixedPoint, b: FixedPoint): FixedPoint;
/**
 * Division always loses precision, so the caller names both the result scale
 * and the direction. Sizing an order is `divide(notional, price, stepScale,
 * "floor")`: never buy more than the budget covers.
 */
export declare function divide(a: FixedPoint, b: FixedPoint, scale: number, rounding: Rounding): FixedPoint;
export declare function compare(a: FixedPoint, b: FixedPoint): -1 | 0 | 1;
export declare function equals(a: FixedPoint, b: FixedPoint): boolean;
export declare function lessThan(a: FixedPoint, b: FixedPoint): boolean;
export declare function greaterThan(a: FixedPoint, b: FixedPoint): boolean;
export declare function isZero(value: FixedPoint): boolean;
export declare function isNegative(value: FixedPoint): boolean;
export declare function isPositive(value: FixedPoint): boolean;
export declare function negate(value: FixedPoint): FixedPoint;
export declare function abs(value: FixedPoint): FixedPoint;
export declare function min(a: FixedPoint, b: FixedPoint): FixedPoint;
export declare function max(a: FixedPoint, b: FixedPoint): FixedPoint;
/**
 * Snap a value down to a multiple of `step`.
 *
 * This is the exchange `stepSize` and `tickSize` rule. Rounding down rather than
 * to nearest matters: a quantity rounded up can exceed the approved notional,
 * and a buy price rounded up pays more than the user confirmed.
 */
export declare function floorToStep(value: FixedPoint, step: FixedPoint): FixedPoint;
/**
 * Basis points, the unit every slippage and fee limit in this system is
 * expressed in. 100 bps is one percent. Integer input only, because a
 * fractional basis point in a configured limit is a typo.
 */
export declare function applyBasisPoints(value: FixedPoint, bps: number, rounding: Rounding): FixedPoint;
