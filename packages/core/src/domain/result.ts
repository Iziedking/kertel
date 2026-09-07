/**
 * Typed results and first-class refusals.
 *
 * A refusal is not an error. It is a correct, expected outcome that Kertel is
 * proud of: "the evidence disagreed", "that is above your cap", "the token
 * belongs to a different proposal". Errors get thrown and logged; refusals get
 * returned, stored, and shown to the user with a reason they can act on.
 *
 * That distinction is the product. A trading agent that can only succeed is a
 * trading agent that will succeed when it should not have.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Stable refusal codes.
 *
 * These are part of Kertel's public contract. They appear in receipts, in the
 * SQLite audit trail, and in the proof output, so a reviewer can grep for the
 * exact refusal a test claims to produce. Renaming one is a breaking change.
 *
 * Grouped by the gate that produces them, in the order a request meets them.
 */
export const REFUSAL_CODES = [
  // Channel and sender. Checked before anything else, including before the
  // model sees the message.
  "SENDER_NOT_ALLOWED",
  "GROUP_MESSAGE_REFUSED",
  "FORWARDED_MESSAGE_REFUSED",

  // Global safety state.
  "KILL_SWITCH_ENGAGED",
  "COOLDOWN_ACTIVE",
  "PENDING_OPERATION_UNRECONCILED",

  // Request shape.
  "SYMBOL_NOT_ALLOWED",
  "COMMAND_NOT_UNDERSTOOD",
  "AMOUNT_NOT_UNDERSTOOD",

  // Research budget, before a single paid call goes out.
  "X402_WALLET_NOT_CONFIGURED",
  "X402_CALL_ABOVE_PER_CALL_CAP",
  "X402_RUN_BUDGET_EXHAUSTED",
  "X402_DAILY_BUDGET_EXHAUSTED",
  "X402_ASSET_NOT_PINNED",
  "X402_RECIPIENT_MISMATCH",
  "X402_NO_ACCEPTABLE_OPTION",
  "X402_PAYMENT_REJECTED",
  "X402_PAYMENT_UNKNOWN",
  // Raised for every paid call *after* an unknown one in the same run. An
  // unresolved payment means Kertel does not know how much it has spent, and a
  // budget it cannot count is not a budget.
  "X402_PAYMENT_UNRESOLVED",

  // Evidence quality. These are the refusals that make the product honest.
  "INSUFFICIENT_EVIDENCE",
  "EVIDENCE_STALE",
  "EVIDENCE_CONFLICT_UNRESOLVED",
  "PROVIDER_UNAVAILABLE",
  "THESIS_SCHEMA_INVALID",
  "MODEL_UNAVAILABLE",

  // Proposal.
  "NOTIONAL_ABOVE_CAP",
  "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
  "INSUFFICIENT_BALANCE",
  "DAILY_LOSS_CAP_REACHED",
  "OPEN_EXPOSURE_ABOVE_CAP",
  "SLIPPAGE_ABOVE_CAP",
  "MARKET_DATA_STALE",
  "NO_TRADE_RECOMMENDED",

  // Confirmation. Every one of these is an adversarial test.
  "TOKEN_NOT_FOUND",
  "TOKEN_ALREADY_CONSUMED",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "TOKEN_SENDER_MISMATCH",
  "TOKEN_PROPOSAL_MISMATCH",
  "PROPOSAL_EXPIRED",
  "PROPOSAL_ALREADY_EXECUTED",
  "PROPOSAL_MUTATED_AFTER_ISSUE",

  // Execution.
  "LIVE_EXECUTION_DISABLED",
  "EXECUTION_ADAPTER_UNAVAILABLE",
  "DUPLICATE_IDEMPOTENCY_KEY",
  "EXCHANGE_REJECTED",
  "EXECUTION_RESULT_UNKNOWN",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * A refusal carries enough for the user to act and enough for an auditor to
 * reconstruct the decision, and never enough to leak a secret.
 *
 * `detail` is written for the person holding the phone. `context` is structured
 * data for the receipt and the log. Nothing that goes in either may contain a
 * private key, a bearer token, a full inbound message, or a payment credential.
 */
export type Refusal = {
  readonly code: RefusalCode;
  readonly detail: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
};

export function refuse(
  code: RefusalCode,
  detail: string,
  context?: Readonly<Record<string, string | number | boolean>>,
): Err<Refusal> {
  return err(context === undefined ? { code, detail } : { code, detail, context });
}

export function isRefusal(value: unknown): value is Refusal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; detail?: unknown };
  return (
    typeof candidate.code === "string" &&
    typeof candidate.detail === "string" &&
    (REFUSAL_CODES as readonly string[]).includes(candidate.code)
  );
}

/**
 * Thrown only for a genuine defect: a broken invariant, an impossible state, a
 * bug. Never for a refusal, and never for an expected external failure.
 */
export class KertelDefect extends Error {
  override readonly name = "KertelDefect";
}

/**
 * Proves a switch is exhaustive. If a new variant is added to a union and a
 * switch forgets it, this fails to compile rather than falling through to a
 * default that guesses.
 */
export function assertNever(value: never, what: string): never {
  throw new KertelDefect(`unhandled ${what}: ${JSON.stringify(value)}`);
}
