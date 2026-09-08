/**
 * Turning a provider's JSON number into a decimal string Telt can price from.
 *
 * Three of the four providers send prices as JSON numbers, which arrive here as
 * IEEE-754 doubles. `packages/core` refuses to work in floats at all, so every
 * number has to become a plain decimal string before it can enter the money
 * layer, and that conversion is where a price can silently change.
 *
 * `String(x)` is used deliberately. It produces the *shortest* decimal that
 * round-trips to the same double, which is the same rule every JSON serialiser
 * uses on the way out. So for a value the provider itself wrote as JSON,
 * `String(JSON.parse(text))` gives back the digits the provider sent. Anything
 * fancier — fixed decimal places, a rounding step, a locale formatter — would
 * either invent digits that were never sent or drop ones that were.
 *
 * The one thing `String` does that fixed point cannot accept is exponent
 * notation, which it uses above 1e21 and below 1e-7. Those are expanded here
 * rather than rejected, because a very small unit price is a real thing and
 * refusing it would be a bug that only shows up on cheap tokens.
 *
 * Strings are passed through after validation instead of being parsed, because
 * Binance sends `"2505.66000000"` and those trailing zeros are the venue's own
 * statement of precision. Round-tripping them through a double would throw that
 * away for no gain.
 */

/** A plain decimal literal: optional sign, digits, optional fractional part. */
const PLAIN_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** Loose enough to catch what providers actually send, including `1e-8`. */
const EXPONENT_FORM = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

function expandExponent(text: string): string | null {
  const match = EXPONENT_FORM.exec(text);
  if (match === null) {
    return null;
  }
  const sign = match[1] ?? "";
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  if (!Number.isInteger(exponent)) {
    return null;
  }

  const digits = whole + fraction;
  // Where the point sits after shifting by the exponent, counted from the left.
  const pointAt = whole.length + exponent;

  let unsigned: string;
  if (pointAt <= 0) {
    unsigned = `0.${"0".repeat(-pointAt)}${digits}`;
  } else if (pointAt >= digits.length) {
    unsigned = digits + "0".repeat(pointAt - digits.length);
  } else {
    unsigned = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  }

  // Strip leading zeros the shift introduced, keeping one before the point.
  unsigned = unsigned.replace(/^0+(?=\d)/, "");
  return sign + unsigned;
}

/**
 * A decimal string for a value that came out of a provider's JSON body.
 *
 * Returns null rather than throwing or guessing. A null becomes an `invalid`
 * observation, the planner routes around that provider, and the user is told a
 * source did not answer usefully — which is true, and is a better outcome than
 * a price built from a number nobody can vouch for.
 */
export function decimalFromJson(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return PLAIN_DECIMAL.test(trimmed) ? trimmed : expandExponent(trimmed);
  }

  if (typeof value !== "number") {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  // Beyond this, consecutive integers are no longer representable, so the digits
  // would be an artefact of the double rather than the provider's figure.
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    return null;
  }

  const text = String(value);
  return PLAIN_DECIMAL.test(text) ? text : expandExponent(text);
}

/**
 * A decimal string for a value that must be strictly positive.
 *
 * Used for prices. Zero is not a price, and a negative one is a broken feed;
 * either way it must not reach the sizing code, which would happily divide by
 * it.
 */
export function positiveDecimalFromJson(value: unknown): string | null {
  const decimal = decimalFromJson(value);
  if (decimal === null || decimal.startsWith("-")) {
    return null;
  }
  return /[1-9]/.test(decimal) ? decimal : null;
}
