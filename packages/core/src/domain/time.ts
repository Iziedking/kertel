/**
 * Time as a dependency, not an ambient fact.
 *
 * Nothing in the core reads the system clock. Every function that needs "now"
 * takes it as an argument, which is what makes expiry, freshness, cooldown and
 * daily-budget behaviour testable without waiting or mocking globals.
 *
 * All instants are UTC. A trading day boundary that drifts with a laptop's
 * timezone is a budget that resets at the wrong moment.
 */

import { KertelDefect } from "./result.js";

/** Milliseconds since the Unix epoch, UTC. */
export type Instant = number & { readonly __brand: "Instant" };

/** A whole number of seconds. Used for TTLs and freshness windows. */
export type Seconds = number & { readonly __brand: "Seconds" };

export function instant(epochMillis: number): Instant {
  if (!Number.isInteger(epochMillis) || epochMillis < 0) {
    throw new KertelDefect(`instant must be a non-negative integer, received ${String(epochMillis)}`);
  }
  return epochMillis as Instant;
}

export function seconds(value: number): Seconds {
  if (!Number.isInteger(value) || value < 0) {
    throw new KertelDefect(`seconds must be a non-negative integer, received ${String(value)}`);
  }
  return value as Seconds;
}

/** Parse an ISO-8601 instant. Rejects anything ambiguous or unparseable. */
export function parseInstant(iso: string): Instant {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new KertelDefect(`not a parseable instant: ${JSON.stringify(iso)}`);
  }
  return instant(parsed);
}

/** The canonical string form used in SQLite, receipts and hashes. */
export function formatInstant(value: Instant): string {
  return new Date(value).toISOString();
}

export function addSeconds(value: Instant, delta: Seconds): Instant {
  return instant(value + delta * 1000);
}

export function secondsBetween(from: Instant, to: Instant): number {
  return (to - from) / 1000;
}

export function isBefore(a: Instant, b: Instant): boolean {
  return a < b;
}

export function isAfterOrEqual(a: Instant, b: Instant): boolean {
  return a >= b;
}

/**
 * The UTC day an instant falls in, as `YYYY-MM-DD`.
 *
 * This is the key the x402 daily spend ledger and the daily loss cap are keyed
 * on. It is UTC on purpose so the ceiling resets at the same moment no matter
 * where the operator is sitting.
 */
export function utcDay(value: Instant): string {
  const iso = new Date(value).toISOString();
  const day = iso.slice(0, 10);
  if (day.length !== 10) {
    throw new KertelDefect(`could not derive a UTC day from ${iso}`);
  }
  return day;
}

/**
 * The only way anything in Kertel learns the time.
 *
 * The live implementation wraps `Date.now`. Tests pass a clock they control, so
 * "the token expired ninety-one seconds after it was issued" is a one-line
 * assertion instead of a sleep.
 */
export type Clock = {
  now(): Instant;
};

export function systemClock(): Clock {
  return { now: () => instant(Date.now()) };
}

/** A clock that stands still until a test moves it. */
export function fixedClock(start: Instant): Clock & { advance(delta: Seconds): void; set(value: Instant): void } {
  let current = start;
  return {
    now: () => current,
    advance(delta: Seconds) {
      current = addSeconds(current, delta);
    },
    set(value: Instant) {
      current = value;
    },
  };
}
