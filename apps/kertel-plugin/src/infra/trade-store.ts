/**
 * The trading half of durable state: proposals, confirmation tokens, operations.
 *
 * Kept in its own file because it answers a different question from the spend
 * ledger. That one exists so a budget survives a restart. This one exists so a
 * *promise* survives a restart: the user is holding a code that Kertel told them
 * means one specific order, and a deploy in between must not change what it
 * means or let it be used twice.
 *
 * Money is stored as decimal strings here, unlike the spend ledger. That is
 * deliberate and safe: nothing in this file adds two amounts together. The
 * ledger needed integer atoms precisely because it accumulates, and SQL would
 * otherwise do that accumulation in floating point.
 *
 * Three constraints are enforced by the schema rather than by code, because a
 * check that lives in one function is a check somebody adds a second caller
 * around:
 *
 * - a confirmation token is unique on its hash, and carries the proposal hash
 *   it was issued against, so a code cannot be replayed onto a different
 *   proposal;
 * - an operation is unique on its idempotency key, so the same proposal cannot
 *   be submitted twice even if two requests race;
 * - an operation points at exactly one proposal.
 */

import type { DatabaseSync } from "node:sqlite";

import * as fp from "@kertel/core/money";
import type { Instant } from "@kertel/core/domain";

export type ProposalRow = {
  readonly id: string;
  readonly senderHash: string;
  readonly symbol: string;
  readonly side: string;
  readonly orderType: string;
  readonly quantity: string;
  readonly referencePrice: string;
  readonly estimatedNotional: string;
  readonly estimatedFee: string;
  readonly maxSlippageBps: number;
  readonly evidenceDigest: string;
  readonly policyVersion: string;
  readonly mode: string;
  readonly proposalHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: string;
};

export type TokenRow = {
  readonly tokenHash: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly senderHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly status: string;
};

export type OperationRow = {
  readonly id: string;
  readonly proposalId: string;
  readonly idempotencyKey: string;
  readonly clientOrderId: string;
  readonly exchangeOrderRef: string | null;
  readonly status: string;
  readonly filledQuantity: string;
  readonly averagePrice: string | null;
  readonly feePaid: string | null;
  readonly submittedAt: number | null;
  readonly reconciledAt: number | null;
  readonly failureCode: string | null;
};

export const TRADE_SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  sender_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  quantity TEXT NOT NULL,
  reference_price TEXT NOT NULL,
  estimated_notional TEXT NOT NULL,
  estimated_fee TEXT NOT NULL,
  max_slippage_bps INTEGER NOT NULL,
  evidence_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmation_tokens (
  token_hash TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals (id),
  proposal_hash TEXT NOT NULL,
  sender_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tokens_by_proposal ON confirmation_tokens (proposal_id);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals (id),
  -- Unique, so the same proposal cannot reach the exchange twice even if two
  -- confirmations race. The insert is the lock.
  idempotency_key TEXT NOT NULL UNIQUE,
  client_order_id TEXT NOT NULL,
  exchange_order_ref TEXT,
  status TEXT NOT NULL,
  filled_quantity TEXT NOT NULL,
  average_price TEXT,
  fee_paid TEXT,
  submitted_at INTEGER,
  reconciled_at INTEGER,
  failure_code TEXT
);

CREATE INDEX IF NOT EXISTS operations_status ON operations (status);

-- A standing plan the human approved once. Basis points are integers, and
-- quantities and prices are decimal strings that nothing in SQL ever adds up.
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  sender_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  ladder_json TEXT NOT NULL,
  stop_loss_bps INTEGER,
  trailing_activate_bps INTEGER,
  trailing_bps INTEGER,
  breakeven_at_bps INTEGER,
  -- The ratchet. Only ever moves up; that is what makes a trailing stop trail.
  high_water_bps INTEGER NOT NULL DEFAULT 0,
  sold_bps INTEGER NOT NULL DEFAULT 0,
  -- What was actually sold, in base units. Floored tranches do not sum back to
  -- the whole, so basis points alone strand dust.
  sold_quantity TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_proposal_id TEXT,
  -- Hash of the one-use code that activates this plan. Never the code itself.
  code_hash TEXT,
  -- The last price seen, so the monitor can tell a gap from a drift.
  last_seen_price TEXT,
  last_checked_at INTEGER
);

CREATE INDEX IF NOT EXISTS mandates_active ON mandates (status);

-- What the agent did, and why. This is the part a person reads to decide
-- whether they trust it: every autonomous action leaves a line here, including
-- the ones where it looked and decided to do nothing.
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  mandate_id TEXT,
  headline TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence TEXT
);

CREATE INDEX IF NOT EXISTS journal_at ON journal (at DESC);

-- Every closed decision, as it actually turned out. Recorded when the exit
-- fires rather than reconstructed later, because a reconstruction is only ever
-- as good as the parser that reads it.
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  exit_price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  move_bps INTEGER NOT NULL,
  peak_bps INTEGER NOT NULL,
  -- Null until somebody checks. A stop that recovered within a day is the
  -- expensive kind of mistake and is worth knowing about specifically.
  recovered_within_24h INTEGER
);

CREATE INDEX IF NOT EXISTS outcomes_at ON outcomes (at DESC);
CREATE INDEX IF NOT EXISTS outcomes_symbol ON outcomes (symbol);

-- Lessons: either derived from the record above, or recalled from the user's
-- own portable memory and handed back so plan-time can show them.
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  text TEXT NOT NULL,
  learned_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (symbol, text)
);

-- Positions Kertel did not open.
--
-- An order placed through Binance Agent OS lands in the Agentic sub-account
-- and Kertel never sees the fill. Without the real entry price it would default
-- an exit plan to the current bid, which silently turns "stop 15% below what I
-- paid" into "stop 15% below wherever it happens to be now".
CREATE TABLE IF NOT EXISTS adopted (
  symbol TEXT PRIMARY KEY,
  entry_price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

function text(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

function toProposal(row: Record<string, unknown>): ProposalRow {
  return {
    id: text(row, "id"),
    senderHash: text(row, "sender_hash"),
    symbol: text(row, "symbol"),
    side: text(row, "side"),
    orderType: text(row, "order_type"),
    quantity: text(row, "quantity"),
    referencePrice: text(row, "reference_price"),
    estimatedNotional: text(row, "estimated_notional"),
    estimatedFee: text(row, "estimated_fee"),
    maxSlippageBps: Number(row["max_slippage_bps"]),
    evidenceDigest: text(row, "evidence_digest"),
    policyVersion: text(row, "policy_version"),
    mode: text(row, "mode"),
    proposalHash: text(row, "proposal_hash"),
    createdAt: Number(row["created_at"]),
    expiresAt: Number(row["expires_at"]),
    status: text(row, "status"),
  };
}

function toToken(row: Record<string, unknown>): TokenRow {
  return {
    tokenHash: text(row, "token_hash"),
    proposalId: text(row, "proposal_id"),
    proposalHash: text(row, "proposal_hash"),
    senderHash: text(row, "sender_hash"),
    issuedAt: Number(row["issued_at"]),
    expiresAt: Number(row["expires_at"]),
    consumedAt: nullableNumber(row, "consumed_at"),
    status: text(row, "status"),
  };
}

function toOperation(row: Record<string, unknown>): OperationRow {
  return {
    id: text(row, "id"),
    proposalId: text(row, "proposal_id"),
    idempotencyKey: text(row, "idempotency_key"),
    clientOrderId: text(row, "client_order_id"),
    exchangeOrderRef: nullableText(row, "exchange_order_ref"),
    status: text(row, "status"),
    filledQuantity: text(row, "filled_quantity"),
    averagePrice: nullableText(row, "average_price"),
    feePaid: nullableText(row, "fee_paid"),
    submittedAt: nullableNumber(row, "submitted_at"),
    reconciledAt: nullableNumber(row, "reconciled_at"),
    failureCode: nullableText(row, "failure_code"),
  };
}

export type TradeStore = {
  saveProposal(row: ProposalRow): void;
  findProposal(id: string): ProposalRow | null;
  /** The most recent proposal still waiting on this sender. */
  latestPreparedProposal(senderHash: string): ProposalRow | null;
  setProposalStatus(id: string, status: string): void;
  saveToken(row: TokenRow): void;
  findToken(tokenHash: string): TokenRow | null;
  /** Marks the token used. Returns false when somebody else already did. */
  consumeToken(tokenHash: string, at: Instant): boolean;
  revokeTokensFor(proposalId: string): void;
  /** Returns false when this proposal already has an operation. */
  claimOperation(row: OperationRow): boolean;
  findOperationByKey(idempotencyKey: string): OperationRow | null;
  updateOperation(row: OperationRow): void;
  unreconciledOperations(): readonly OperationRow[];
};

export function tradeStore(db: DatabaseSync): TradeStore {
  return {
    saveProposal(row) {
      db.prepare(
        `INSERT OR REPLACE INTO proposals
           (id, sender_hash, symbol, side, order_type, quantity, reference_price,
            estimated_notional, estimated_fee, max_slippage_bps, evidence_digest,
            policy_version, mode, proposal_hash, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.senderHash,
        row.symbol,
        row.side,
        row.orderType,
        row.quantity,
        row.referencePrice,
        row.estimatedNotional,
        row.estimatedFee,
        row.maxSlippageBps,
        row.evidenceDigest,
        row.policyVersion,
        row.mode,
        row.proposalHash,
        row.createdAt,
        row.expiresAt,
        row.status,
      );
    },

    findProposal(id) {
      const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : toProposal(row);
    },

    latestPreparedProposal(senderHash) {
      const row = db
        .prepare(
          "SELECT * FROM proposals WHERE sender_hash = ? AND status = 'prepared' ORDER BY created_at DESC LIMIT 1",
        )
        .get(senderHash) as Record<string, unknown> | undefined;
      return row === undefined ? null : toProposal(row);
    },

    setProposalStatus(id, status) {
      db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
    },

    saveToken(row) {
      db.prepare(
        `INSERT OR REPLACE INTO confirmation_tokens
           (token_hash, proposal_id, proposal_hash, sender_hash, issued_at, expires_at, consumed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.tokenHash,
        row.proposalId,
        row.proposalHash,
        row.senderHash,
        row.issuedAt,
        row.expiresAt,
        row.consumedAt,
        row.status,
      );
    },

    findToken(tokenHash) {
      const row = db
        .prepare("SELECT * FROM confirmation_tokens WHERE token_hash = ?")
        .get(tokenHash) as Record<string, unknown> | undefined;
      return row === undefined ? null : toToken(row);
    },

    consumeToken(tokenHash, at) {
      // The WHERE clause is the lock. Two confirmations arriving together both
      // run this, and exactly one of them changes a row; the loser sees zero
      // changes and is told the code was already used.
      const result = db
        .prepare(
          "UPDATE confirmation_tokens SET status = 'consumed', consumed_at = ? WHERE token_hash = ? AND status = 'active'",
        )
        .run(at, tokenHash);
      return Number(result.changes) === 1;
    },

    revokeTokensFor(proposalId) {
      db.prepare(
        "UPDATE confirmation_tokens SET status = 'revoked' WHERE proposal_id = ? AND status = 'active'",
      ).run(proposalId);
    },

    claimOperation(row) {
      try {
        db.prepare(
          `INSERT INTO operations
             (id, proposal_id, idempotency_key, client_order_id, exchange_order_ref,
              status, filled_quantity, average_price, fee_paid, submitted_at,
              reconciled_at, failure_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.proposalId,
          row.idempotencyKey,
          row.clientOrderId,
          row.exchangeOrderRef,
          row.status,
          row.filledQuantity,
          row.averagePrice,
          row.feePaid,
          row.submittedAt,
          row.reconciledAt,
          row.failureCode,
        );
        return true;
      } catch {
        // The unique index on the idempotency key rejected it: this proposal has
        // already been submitted. That is the duplicate guard working, not an
        // error to surface as a crash.
        return false;
      }
    },

    findOperationByKey(idempotencyKey) {
      const row = db
        .prepare("SELECT * FROM operations WHERE idempotency_key = ?")
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      return row === undefined ? null : toOperation(row);
    },

    updateOperation(row) {
      db.prepare(
        `UPDATE operations SET exchange_order_ref = ?, status = ?, filled_quantity = ?,
           average_price = ?, fee_paid = ?, submitted_at = ?, reconciled_at = ?, failure_code = ?
         WHERE id = ?`,
      ).run(
        row.exchangeOrderRef,
        row.status,
        row.filledQuantity,
        row.averagePrice,
        row.feePaid,
        row.submittedAt,
        row.reconciledAt,
        row.failureCode,
        row.id,
      );
    },

    unreconciledOperations() {
      // `unknown` is the one that matters: submitted, never resolved. `submitted`
      // and `accepted` are in flight and also block a new proposal until they
      // land, because open exposure Kertel cannot see is exposure it cannot cap.
      const rows = db
        .prepare(
          "SELECT * FROM operations WHERE status IN ('unknown', 'submitted', 'accepted', 'partial') ORDER BY submitted_at ASC",
        )
        .all() as readonly Record<string, unknown>[];
      return rows.map(toOperation);
    },
  };
}

/** Decimal string to fixed point, for reading rows back into the domain. */
export function money(raw: string): ReturnType<typeof fp.parse> {
  return fp.parse(raw);
}
