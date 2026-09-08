/**
 * Durable state, on `node:sqlite`.
 *
 * **Why not better-sqlite3.** OpenClaw installs plugin dependencies with
 * `npm install --ignore-scripts` (see `docs/tools/plugin.md` in the installed
 * release), which means a dependency needing a native build step will not
 * build. `node:sqlite` ships inside Node 22 and needs no toolchain, no
 * postinstall, and no Windows build environment on the operator's machine.
 *
 * It is marked experimental and prints a warning on first use, so everything it
 * touches sits behind the `Store` interface below. Swapping in better-sqlite3
 * later, if the API moves, is one file and no callers.
 *
 * What lives here is the state that must survive a restart, and the reason each
 * one must:
 *
 * - **the spend ledger**, because a daily cap that resets when the process does
 *   is not a cap;
 * - **proposals and their confirmation tokens**, because a code the user is
 *   holding has to still mean something after a deploy;
 * - **the safety state**, because a kill switch that forgets it was pulled is
 *   not a kill switch;
 * - **payment attempts**, because an unresolved payment is money Telt cannot
 *   account for and the only way to reconcile it later is to have written it
 *   down at the time.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import * as fp from "@telt/core/money";
import { TRADE_SCHEMA, tradeStore } from "./trade-store.js";
import type { TradeStore } from "./trade-store.js";
import { mandateStore } from "./mandate-store.js";
import type { MandateStore } from "./mandate-store.js";
import type { FixedPoint } from "@telt/core/money";
import { utcDay } from "@telt/core/domain";
import type { Instant, SafetyState } from "@telt/core/domain";

export type PaymentAttemptRow = {
  readonly attemptId: string;
  readonly provider: string;
  readonly endpointId: string;
  readonly chargedUsdc: string;
  readonly rail: string | null;
  readonly facilitator: string | null;
  readonly settlementTx: string | null;
  readonly outcome: string;
  readonly refusalCode: string | null;
  readonly at: number;
};

export type Store = {
  /** Spent today, in the UTC day the instant falls in. */
  spentOn(day: Instant): FixedPoint;
  recordSpend(day: Instant, amount: FixedPoint): void;
  recordPaymentAttempt(row: PaymentAttemptRow): void;
  /** Attempts that were signed and never confirmed. Reconciliation reads these. */
  unresolvedPayments(): readonly PaymentAttemptRow[];
  resolvePayment(attemptId: string, settlementTx: string | null): void;
  safetyState(): SafetyState;
  engageKillSwitch(reason: string, at: Instant): void;
  releaseKillSwitch(): void;
  /** Proposals, confirmation tokens and operations. */
  readonly trades: TradeStore;
  /** Standing exit plans, and the journal of what the agent did about them. */
  readonly mandates: MandateStore;
  readonly attestations: AttestationStore;
  close(): void;
};

const SCHEMA = `
-- Spend is stored as INTEGER atoms at a fixed scale, never as a decimal string
-- and never as a REAL. SQLite would happily do the addition in floating point,
-- which is the one arithmetic this product does not allow anywhere near money.
-- Integer atoms make the running total exact, and SQLite's 64-bit INTEGER holds
-- nine trillion dollars at micro-dollar precision.
CREATE TABLE IF NOT EXISTS spend_ledger (
  utc_day TEXT PRIMARY KEY,
  spent_atoms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  attempt_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  charged_usdc TEXT NOT NULL,
  rail TEXT,
  facilitator TEXT,
  settlement_tx TEXT,
  outcome TEXT NOT NULL,
  refusal_code TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_attempts_outcome ON payment_attempts (outcome);

CREATE TABLE IF NOT EXISTS safety (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch_engaged INTEGER NOT NULL DEFAULT 0,
  kill_switch_reason TEXT,
  kill_switch_engaged_at INTEGER,
  cooldown_until INTEGER
);

INSERT OR IGNORE INTO safety (id, kill_switch_engaged) VALUES (1, 0);
`;

/** Micro-dollars. Fixed for the life of the table; changing it is a migration. */
const LEDGER_SCALE = 6;

type SpendRow = { readonly spent_atoms: number | bigint };
type SafetyRow = {
  readonly kill_switch_engaged: number;
  readonly kill_switch_reason: string | null;
  readonly kill_switch_engaged_at: number | null;
  readonly cooldown_until: number | null;
};

export function openStore(path: string): Store {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // Survive an unclean shutdown with the ledger intact rather than fast.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(TRADE_SCHEMA);
  migrate(db);

  const trades = tradeStore(db);
  const mandates = mandateStore(db);

  return {
    trades,
    mandates,
    attestations: attestationStore(db),
    spentOn(day: Instant): FixedPoint {
      const row = db
        .prepare("SELECT spent_atoms FROM spend_ledger WHERE utc_day = ?")
        .get(utcDay(day)) as SpendRow | undefined;
      return row === undefined
        ? fp.zero(LEDGER_SCALE)
        : fp.fromAtoms(BigInt(row.spent_atoms), LEDGER_SCALE);
    },

    recordSpend(day: Instant, amount: FixedPoint): void {
      if (!fp.isPositive(amount)) {
        return;
      }
      // `exactOnly` rather than a rounding mode. An amount too fine to store at
      // micro-dollar precision is not something to quietly round into the
      // ledger; it means a provider is charging in units this table was not
      // designed for, and that is worth a loud failure.
      const atoms = fp.rescale(amount, LEDGER_SCALE, "trunc", { exactOnly: true }).atoms;

      // Read-then-write in one statement, in integer arithmetic. Two runs
      // finishing at once must not each add to the figure they both read.
      db.prepare(
        `INSERT INTO spend_ledger (utc_day, spent_atoms) VALUES (?, ?)
         ON CONFLICT(utc_day) DO UPDATE SET
           spent_atoms = spend_ledger.spent_atoms + excluded.spent_atoms`,
      ).run(utcDay(day), atoms);
    },

    recordPaymentAttempt(row: PaymentAttemptRow): void {
      db.prepare(
        `INSERT OR REPLACE INTO payment_attempts
           (attempt_id, provider, endpoint_id, charged_usdc, rail, facilitator,
            settlement_tx, outcome, refusal_code, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.attemptId,
        row.provider,
        row.endpointId,
        row.chargedUsdc,
        row.rail,
        row.facilitator,
        row.settlementTx,
        row.outcome,
        row.refusalCode,
        row.at,
      );
    },

    unresolvedPayments(): readonly PaymentAttemptRow[] {
      const rows = db
        .prepare("SELECT * FROM payment_attempts WHERE outcome = 'unknown' ORDER BY at ASC")
        .all() as readonly Record<string, unknown>[];
      return rows.map((row) => ({
        attemptId: String(row["attempt_id"]),
        provider: String(row["provider"]),
        endpointId: String(row["endpoint_id"]),
        chargedUsdc: String(row["charged_usdc"]),
        rail: row["rail"] === null ? null : String(row["rail"]),
        facilitator: row["facilitator"] === null ? null : String(row["facilitator"]),
        settlementTx: row["settlement_tx"] === null ? null : String(row["settlement_tx"]),
        outcome: String(row["outcome"]),
        refusalCode: row["refusal_code"] === null ? null : String(row["refusal_code"]),
        at: Number(row["at"]),
      }));
    },

    resolvePayment(attemptId: string, settlementTx: string | null): void {
      db.prepare(
        "UPDATE payment_attempts SET outcome = 'paid', settlement_tx = ? WHERE attempt_id = ?",
      ).run(settlementTx, attemptId);
    },

    safetyState(): SafetyState {
      const row = db.prepare("SELECT * FROM safety WHERE id = 1").get() as SafetyRow | undefined;
      if (row === undefined) {
        // The row is seeded by the schema. Its absence is a corrupted database,
        // and the safe reading of "I cannot tell whether the kill switch is on"
        // is that it is.
        return {
          killSwitchEngaged: true,
          killSwitchReason: "The safety row is missing from the database.",
          killSwitchEngagedAt: null,
          cooldownUntil: null,
          unreconciledOperations: [],
        };
      }
      return {
        killSwitchEngaged: row.kill_switch_engaged === 1,
        killSwitchReason: row.kill_switch_reason,
        killSwitchEngagedAt: row.kill_switch_engaged_at as Instant | null,
        cooldownUntil: row.cooldown_until as Instant | null,
        // Real, not empty. An order Telt submitted and never resolved is open
        // exposure it cannot see, and the proposal gate refuses while any exist.
        unreconciledOperations: trades
          .unreconciledOperations()
          .map((operation) => operation.id as SafetyState["unreconciledOperations"][number]),
      };
    },

    engageKillSwitch(reason: string, at: Instant): void {
      db.prepare(
        "UPDATE safety SET kill_switch_engaged = 1, kill_switch_reason = ?, kill_switch_engaged_at = ? WHERE id = 1",
      ).run(reason, at);
    },

    releaseKillSwitch(): void {
      db.prepare(
        "UPDATE safety SET kill_switch_engaged = 0, kill_switch_reason = NULL, kill_switch_engaged_at = NULL WHERE id = 1",
      ).run();
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * Bring an older database up to the current shape.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added after someone started using Telt never appears on their
 * database — and the failure is silent until a query asks for it. Anyone
 * running a live position through an upgrade has exactly that database.
 *
 * Each step is checked before it is applied and is safe to run on every start.
 * There is no version counter on purpose: the checks are the version, and they
 * cannot disagree with reality the way a counter can.
 */
function migrate(db: DatabaseSync): void {
  const columns = (name: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${name})`).all() as Record<string, unknown>[]).map((row) =>
        String(row["name"]),
      ),
    );

  // Added when futures exits arrived. Everything written before then was spot,
  // which is exactly what the default says.
  if (!columns("mandates").has("market")) {
    db.exec("ALTER TABLE mandates ADD COLUMN market TEXT NOT NULL DEFAULT 'spot'");
  }
}

/** Signed proofs, addressed by what they commit to. */
export type AttestationStore = {
  save(provenance: string, document: string, at: Instant): void;
  find(provenance: string): string | null;
  /** Attach the order this evidence justified, once it exists. */
  attachOrder(provenance: string, orderRef: string): void;
  recent(limit: number): readonly { readonly provenance: string; readonly at: number }[];
};

function attestationStore(db: DatabaseSync): AttestationStore {
  return {
    save(provenance, document, at) {
      // Ignore rather than replace: the first proof over a given body of
      // evidence is the one whose timestamp means something.
      db.prepare(
        "INSERT OR IGNORE INTO attestations (provenance, document, at) VALUES (?, ?, ?)",
      ).run(provenance, document, at);
    },

    find(provenance) {
      const row = db
        .prepare("SELECT document FROM attestations WHERE provenance = ?")
        .get(provenance) as Record<string, unknown> | undefined;
      return row === undefined ? null : String(row["document"]);
    },

    attachOrder(provenance, orderRef) {
      db.prepare("UPDATE attestations SET order_ref = ? WHERE provenance = ?").run(
        orderRef,
        provenance,
      );
    },

    recent(limit) {
      const rows = db
        .prepare("SELECT provenance, at FROM attestations ORDER BY at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[];
      return rows.map((row) => ({ provenance: String(row["provenance"]), at: Number(row["at"]) }));
    },
  };
}
