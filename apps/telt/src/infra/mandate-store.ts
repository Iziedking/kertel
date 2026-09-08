/**
 * Mandates and the journal, on the same database as everything else.
 *
 * Two tables, two different jobs.
 *
 * **Mandates** are the plans the human approved. They carry state the monitor
 * writes back — the high-water mark and how much has been sold — because a
 * trailing stop that forgets its peak on restart is not a trailing stop, and a
 * ladder that forgets what it sold will sell it again.
 *
 * **The journal** is the part a person reads to decide whether they trust this
 * thing. Every autonomous action leaves a line, including the ones where the
 * agent looked and chose to do nothing. An agent that only logs its trades is
 * indistinguishable from one that got lucky.
 */

import type { DatabaseSync } from "node:sqlite";

import * as fp from "@telt/core/money";
import type { Instant, ProposalId, SenderIdHash, Symbol_ } from "@telt/core/domain";
import type { ExitMandate, LadderRung, MandateId, MandateStatus } from "@telt/core/mandates";
import type { Lesson, Outcome } from "../review.js";

export type JournalKind =
  | "mandate_created"
  | "mandate_cancelled"
  | "checked"
  | "exit_fired"
  | "exit_failed"
  | "evidence_taken"
  | "halted"
  | "hedge_proposed"
  | "hedge_opened"
  | "hedge_checked"
  | "hedge_researched"
  | "hedge_closed";

export type ProtectionMandate = {
  readonly id: string;
  readonly symbol: string;
  readonly targetCoverageBps: number;
  readonly toleranceBps: number;
  readonly maxNotional: string;
  readonly leverage: number;
  readonly maxAdjustmentBps: number;
  readonly version: number;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly cooldownMs: number;
  readonly status: "active" | "revoked" | "expired";
  readonly lastActionAt: Instant | null;
  readonly checkpointAt: Instant | null;
  readonly lastState: string | null;
};

export type GuardOperation = {
  readonly id: string;
  readonly mandateId: string;
  readonly symbol: string;
  readonly idempotencyKey: string;
  readonly clientOrderId: string;
  readonly action: "increase" | "reduce";
  readonly quantity: string;
  readonly status: "planned" | "submitted" | "filled" | "rejected" | "partial" | "unknown";
  readonly orderRef: string | null;
  readonly filledQuantity: string;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export type JournalEntry = {
  readonly at: Instant;
  readonly kind: JournalKind;
  readonly symbol: string | null;
  readonly mandateId: string | null;
  readonly headline: string;
  readonly detail: string;
  /** A receipt, a refusal, whatever backs the line up. Shown on request. */
  readonly evidence: string | null;
};

export type MandateStore = {
  save(
    mandate: ExitMandate,
    lastSeenPrice: string | null,
    lastCheckedAt: Instant | null,
    codeHash?: string | null,
  ): void;
  /** Activate a pending plan. False when the code matches nothing pending. */
  activate(codeHash: string): ExitMandate | null;
  find(id: string): ExitMandate | null;
  active(): readonly ExitMandate[];
  all(): readonly ExitMandate[];
  /** Price at the previous check, so the monitor can tell a gap from a drift. */
  lastSeen(id: string): { readonly price: string | null; readonly at: number | null };
  setStatus(id: string, status: MandateStatus): void;
  /** Ratchet the peak and record what has been sold. Never lowers the peak. */
  recordProgress(id: string, highWaterBps: number, soldBps: number, soldQuantity: string): void;
  recordCheck(id: string, price: string, at: Instant): void;

  journal(entry: JournalEntry): void;
  recentJournal(limit: number): readonly JournalEntry[];

  recordOutcome(outcome: Outcome): void;
  outcomes(limit: number): readonly Outcome[];
  /**
   * Exits old enough to judge, whose verdict is still unanswered.
   *
   * "Was that stop right?" cannot be answered when the stop fires. It is
   * answered a day later by looking at where the price went.
   */
  outcomesAwaitingVerdict(before: Instant): readonly (Outcome & { readonly rowId: number })[];
  settleVerdict(rowId: number, recovered: boolean): void;
  /** Store a lesson. Duplicates are ignored rather than piling up. */
  /** Remember what a position opened elsewhere actually cost. */
  adopt(input: {
    symbol: string;
    entryPrice: string;
    quantity: string;
    source: string;
    at: Instant;
  }): void;
  adopted(symbol: string): { entryPrice: string; quantity: string; source: string } | null;
  allAdopted(): readonly {
    readonly symbol: string;
    readonly entryPrice: string;
    readonly quantity: string;
    readonly source: string;
  }[];
  forgetAdopted(symbol: string): void;

  saveProtection(mandate: ProtectionMandate): void;
  activeProtection(symbol?: string, now?: Instant): ProtectionMandate | null;
  allProtection(): readonly ProtectionMandate[];
  revokeProtection(id: string, at: Instant): void;
  checkpointProtection(id: string, input: { readonly at: Instant; readonly state: string; readonly actionAt?: Instant | null }): void;
  claimGuardOperation(operation: GuardOperation): boolean;
  findGuardOperation(idempotencyKey: string): GuardOperation | null;
  updateGuardOperation(id: string, input: { readonly status: GuardOperation["status"]; readonly orderRef?: string | null; readonly filledQuantity?: string; readonly at: Instant }): void;
  unresolvedGuardOperations(): readonly GuardOperation[];

  learn(lesson: Lesson): void;
  lessonsFor(symbol: string): readonly Lesson[];
  allLessons(): readonly Lesson[];
};

function toMandate(row: Record<string, unknown>): ExitMandate {
  const activate = row["trailing_activate_bps"];
  const trail = row["trailing_bps"];
  return {
    id: String(row["id"]) as MandateId,
    senderIdHash: String(row["sender_hash"]) as SenderIdHash,
    symbol: String(row["symbol"]) as Symbol_,
    // Rows written before futures existed carry no market; they are all spot.
    market: row["market"] === "futures" ? "futures" : "spot",
    entryPrice: fp.parse(String(row["entry_price"])),
    quantity: fp.parse(String(row["quantity"])),
    ladder: JSON.parse(String(row["ladder_json"])) as readonly LadderRung[],
    stopLossBps: row["stop_loss_bps"] === null ? null : Number(row["stop_loss_bps"]),
    trailing:
      activate === null || trail === null
        ? null
        : { activateAtBps: Number(activate), trailBps: Number(trail) },
    breakevenAtBps: row["breakeven_at_bps"] === null ? null : Number(row["breakeven_at_bps"]),
    highWaterBps: Number(row["high_water_bps"]),
    soldBps: Number(row["sold_bps"]),
    soldQuantity: fp.parse(String(row["sold_quantity"] ?? "0")),
    createdAt: Number(row["created_at"]) as Instant,
    expiresAt: Number(row["expires_at"]) as Instant,
    status: String(row["status"]) as MandateStatus,
    sourceProposalId:
      row["source_proposal_id"] === null ? null : (String(row["source_proposal_id"]) as ProposalId),
  };
}

function toLesson(row: Record<string, unknown>): Lesson {
  return {
    symbol: String(row["symbol"]),
    text: String(row["text"]),
    learnedAt: Number(row["learned_at"]) as Instant,
    source: String(row["source"]) as Lesson["source"],
  };
}

function toJournal(row: Record<string, unknown>): JournalEntry {
  return {
    at: Number(row["at"]) as Instant,
    kind: String(row["kind"]) as JournalKind,
    symbol: row["symbol"] === null ? null : String(row["symbol"]),
    mandateId: row["mandate_id"] === null ? null : String(row["mandate_id"]),
    headline: String(row["headline"]),
    detail: String(row["detail"]),
    evidence: row["evidence"] === null ? null : String(row["evidence"]),
  };
}

function toProtection(row: Record<string, unknown>): ProtectionMandate {
  return {
    id: String(row["id"]),
    symbol: String(row["symbol"]),
    targetCoverageBps: Number(row["target_coverage_bps"]),
    toleranceBps: Number(row["tolerance_bps"]),
    maxNotional: String(row["max_notional"]),
    leverage: Number(row["leverage"]),
    maxAdjustmentBps: Number(row["max_adjustment_bps"]),
    version: Number(row["version"]),
    createdAt: Number(row["created_at"]) as Instant,
    expiresAt: Number(row["expires_at"]) as Instant,
    cooldownMs: Number(row["cooldown_ms"]),
    status: String(row["status"]) as ProtectionMandate["status"],
    lastActionAt: row["last_action_at"] === null ? null : (Number(row["last_action_at"]) as Instant),
    checkpointAt: row["checkpoint_at"] === null ? null : (Number(row["checkpoint_at"]) as Instant),
    lastState: row["last_state"] === null ? null : String(row["last_state"]),
  };
}

function toGuardOperation(row: Record<string, unknown>): GuardOperation {
  return {
    id: String(row["id"]),
    mandateId: String(row["mandate_id"]),
    symbol: String(row["symbol"]),
    idempotencyKey: String(row["idempotency_key"]),
    clientOrderId: String(row["client_order_id"]),
    action: String(row["action"]) as GuardOperation["action"],
    quantity: String(row["quantity"]),
    status: String(row["status"]) as GuardOperation["status"],
    orderRef: row["order_ref"] === null ? null : String(row["order_ref"]),
    filledQuantity: String(row["filled_quantity"]),
    createdAt: Number(row["created_at"]) as Instant,
    updatedAt: Number(row["updated_at"]) as Instant,
  };
}

export function mandateStore(db: DatabaseSync): MandateStore {
  db.exec(`CREATE TABLE IF NOT EXISTS protection_mandates (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, target_coverage_bps INTEGER NOT NULL,
    tolerance_bps INTEGER NOT NULL, max_notional TEXT NOT NULL, leverage INTEGER NOT NULL,
    max_adjustment_bps INTEGER NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, cooldown_ms INTEGER NOT NULL, status TEXT NOT NULL,
    last_action_at INTEGER, checkpoint_at INTEGER, last_state TEXT
  );
  CREATE INDEX IF NOT EXISTS protection_mandates_active ON protection_mandates(status, symbol);
  CREATE TABLE IF NOT EXISTS guard_operations (
    id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, symbol TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE, client_order_id TEXT NOT NULL,
    action TEXT NOT NULL, quantity TEXT NOT NULL, status TEXT NOT NULL,
    order_ref TEXT, filled_quantity TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS guard_operations_status ON guard_operations(status);`);
  return {
    save(mandate, lastSeenPrice, lastCheckedAt, codeHash = null) {
      db.prepare(
        `INSERT OR REPLACE INTO mandates
           (id, sender_hash, symbol, market, entry_price, quantity, ladder_json, stop_loss_bps,
            trailing_activate_bps, trailing_bps, breakeven_at_bps, high_water_bps, sold_bps,
            sold_quantity, created_at, expires_at, status, source_proposal_id, code_hash,
            last_seen_price, last_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mandate.id,
        mandate.senderIdHash,
        mandate.symbol,
        mandate.market,
        fp.format(mandate.entryPrice),
        fp.format(mandate.quantity),
        JSON.stringify(mandate.ladder),
        mandate.stopLossBps,
        mandate.trailing?.activateAtBps ?? null,
        mandate.trailing?.trailBps ?? null,
        mandate.breakevenAtBps,
        mandate.highWaterBps,
        mandate.soldBps,
        fp.format(mandate.soldQuantity),
        mandate.createdAt,
        mandate.expiresAt,
        mandate.status,
        mandate.sourceProposalId,
        codeHash,
        lastSeenPrice,
        lastCheckedAt,
      );
    },

    activate(codeHash) {
      // Conditional UPDATE, so two activations of the same code race to one
      // winner and the loser is told it was already used.
      const result = db
        .prepare("UPDATE mandates SET status = 'active' WHERE code_hash = ? AND status = 'pending'")
        .run(codeHash);
      if (Number(result.changes) !== 1) {
        return null;
      }
      const row = db.prepare("SELECT * FROM mandates WHERE code_hash = ?").get(codeHash) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : toMandate(row);
    },

    find(id) {
      const row = db.prepare("SELECT * FROM mandates WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? null : toMandate(row);
    },

    active() {
      const rows = db
        .prepare("SELECT * FROM mandates WHERE status = 'active' ORDER BY created_at ASC")
        .all() as readonly Record<string, unknown>[];
      return rows.map(toMandate);
    },

    all() {
      const rows = db
        .prepare("SELECT * FROM mandates ORDER BY created_at DESC")
        .all() as readonly Record<string, unknown>[];
      return rows.map(toMandate);
    },

    lastSeen(id) {
      const row = db
        .prepare("SELECT last_seen_price, last_checked_at FROM mandates WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (row === undefined) {
        return { price: null, at: null };
      }
      return {
        price: row["last_seen_price"] === null ? null : String(row["last_seen_price"]),
        at: row["last_checked_at"] === null ? null : Number(row["last_checked_at"]),
      };
    },

    setStatus(id, status) {
      db.prepare("UPDATE mandates SET status = ? WHERE id = ?").run(status, id);
    },

    recordProgress(id, highWaterBps, soldBps, soldQuantity) {
      // `MAX` in the statement, not in the caller. The peak is the one piece of
      // mandate state that must never move backwards, and enforcing that here
      // means a careless caller cannot undo a trailing stop.
      db.prepare(
        "UPDATE mandates SET high_water_bps = MAX(high_water_bps, ?), sold_bps = ?, sold_quantity = ? WHERE id = ?",
      ).run(highWaterBps, soldBps, soldQuantity, id);
    },

    recordCheck(id, price, at) {
      db.prepare("UPDATE mandates SET last_seen_price = ?, last_checked_at = ? WHERE id = ?").run(
        price,
        at,
        id,
      );
    },

    journal(entry) {
      db.prepare(
        `INSERT INTO journal (at, kind, symbol, mandate_id, headline, detail, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.at,
        entry.kind,
        entry.symbol,
        entry.mandateId,
        entry.headline,
        entry.detail,
        entry.evidence,
      );
    },

    recentJournal(limit) {
      const rows = db
        .prepare("SELECT * FROM journal ORDER BY at DESC, id DESC LIMIT ?")
        .all(limit) as readonly Record<string, unknown>[];
      return rows.map(toJournal);
    },

    recordOutcome(outcome) {
      db.prepare(
        `INSERT INTO outcomes
           (at, symbol, mandate_id, reason, entry_price, exit_price, quantity,
            move_bps, peak_bps, recovered_within_24h)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        outcome.at,
        outcome.symbol,
        outcome.mandateId,
        outcome.reason,
        outcome.entryPrice,
        outcome.exitPrice,
        outcome.quantity,
        outcome.moveBps,
        outcome.peakBps,
        outcome.recoveredWithin24h === null ? null : outcome.recoveredWithin24h ? 1 : 0,
      );
    },

    outcomes(limit) {
      const rows = db
        .prepare("SELECT * FROM outcomes ORDER BY at DESC, id DESC LIMIT ?")
        .all(limit) as readonly Record<string, unknown>[];
      return rows.map((row) => ({
        at: Number(row["at"]) as Instant,
        symbol: String(row["symbol"]),
        mandateId: String(row["mandate_id"]),
        reason: String(row["reason"]),
        entryPrice: String(row["entry_price"]),
        exitPrice: String(row["exit_price"]),
        quantity: String(row["quantity"]),
        moveBps: Number(row["move_bps"]),
        peakBps: Number(row["peak_bps"]),
        recoveredWithin24h:
          row["recovered_within_24h"] === null ? null : Number(row["recovered_within_24h"]) === 1,
      }));
    },

    outcomesAwaitingVerdict(before) {
      const rows = db
        .prepare(
          "SELECT rowid AS row_id, * FROM outcomes WHERE recovered_within_24h IS NULL AND at <= ? ORDER BY at ASC LIMIT 20",
        )
        .all(before) as readonly Record<string, unknown>[];
      return rows.map((row) => ({
        rowId: Number(row["row_id"]),
        at: Number(row["at"]) as Instant,
        symbol: String(row["symbol"]),
        mandateId: String(row["mandate_id"]),
        reason: String(row["reason"]),
        entryPrice: String(row["entry_price"]),
        exitPrice: String(row["exit_price"]),
        quantity: String(row["quantity"]),
        moveBps: Number(row["move_bps"]),
        peakBps: Number(row["peak_bps"]),
        recoveredWithin24h: null,
      }));
    },

    settleVerdict(rowId, recovered) {
      db.prepare("UPDATE outcomes SET recovered_within_24h = ? WHERE rowid = ?").run(
        recovered ? 1 : 0,
        rowId,
      );
    },

    adopt(input) {
      db.prepare(
        "INSERT OR REPLACE INTO adopted (symbol, entry_price, quantity, source, at) VALUES (?, ?, ?, ?, ?)",
      ).run(input.symbol, input.entryPrice, input.quantity, input.source, input.at);
    },

    adopted(symbol) {
      const row = db.prepare("SELECT * FROM adopted WHERE symbol = ?").get(symbol) as
        | Record<string, unknown>
        | undefined;
      return row === undefined
        ? null
        : {
            entryPrice: String(row["entry_price"]),
            quantity: String(row["quantity"]),
            source: String(row["source"]),
          };
    },

    allAdopted() {
      const rows = db.prepare("SELECT * FROM adopted ORDER BY at ASC").all() as readonly Record<
        string,
        unknown
      >[];
      return rows.map((row) => ({
        symbol: String(row["symbol"]),
        entryPrice: String(row["entry_price"]),
        quantity: String(row["quantity"]),
        source: String(row["source"]),
      }));
    },

    forgetAdopted(symbol) {
      db.prepare("DELETE FROM adopted WHERE symbol = ?").run(symbol);
    },

    saveProtection(mandate) {
      db.prepare(`INSERT OR REPLACE INTO protection_mandates
        (id, symbol, target_coverage_bps, tolerance_bps, max_notional, leverage,
         max_adjustment_bps, version, created_at, expires_at, cooldown_ms, status,
         last_action_at, checkpoint_at, last_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(mandate.id, mandate.symbol, mandate.targetCoverageBps, mandate.toleranceBps,
          mandate.maxNotional, mandate.leverage, mandate.maxAdjustmentBps, mandate.version,
          mandate.createdAt, mandate.expiresAt, mandate.cooldownMs, mandate.status,
          mandate.lastActionAt, mandate.checkpointAt, mandate.lastState);
    },

    activeProtection(symbol, now) {
      const row = db.prepare("SELECT * FROM protection_mandates WHERE status = 'active' AND expires_at > ? AND (? IS NULL OR symbol = ?) ORDER BY created_at DESC LIMIT 1")
        .get(now ?? Date.now(), symbol ?? null, symbol ?? null) as Record<string, unknown> | undefined;
      return row === undefined ? null : toProtection(row);
    },

    allProtection() {
      const rows = db.prepare("SELECT * FROM protection_mandates ORDER BY created_at DESC").all() as Record<string, unknown>[];
      return rows.map(toProtection);
    },

    revokeProtection(id, at) {
      db.prepare("UPDATE protection_mandates SET status = 'revoked', checkpoint_at = ? WHERE id = ? AND status = 'active'").run(at, id);
    },

    checkpointProtection(id, input) {
      db.prepare("UPDATE protection_mandates SET checkpoint_at = ?, last_state = ?, last_action_at = COALESCE(?, last_action_at) WHERE id = ? AND status = 'active'").run(input.at, input.state, input.actionAt ?? null, id);
    },

    claimGuardOperation(operation) {
      try {
        db.prepare(`INSERT INTO guard_operations
          (id, mandate_id, symbol, idempotency_key, client_order_id, action,
           quantity, status, order_ref, filled_quantity, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            operation.id, operation.mandateId, operation.symbol,
            operation.idempotencyKey, operation.clientOrderId, operation.action,
            operation.quantity, operation.status, operation.orderRef,
            operation.filledQuantity, operation.createdAt, operation.updatedAt,
          );
        return true;
      } catch {
        return false;
      }
    },

    findGuardOperation(idempotencyKey) {
      const row = db.prepare("SELECT * FROM guard_operations WHERE idempotency_key = ?")
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      return row === undefined ? null : toGuardOperation(row);
    },

    updateGuardOperation(id, input) {
      db.prepare(`UPDATE guard_operations
        SET status = ?, order_ref = COALESCE(?, order_ref),
            filled_quantity = COALESCE(?, filled_quantity), updated_at = ?
        WHERE id = ?`).run(
          input.status, input.orderRef ?? null, input.filledQuantity ?? null,
          input.at, id,
        );
    },

    unresolvedGuardOperations() {
      const rows = db.prepare("SELECT * FROM guard_operations WHERE status IN ('planned', 'submitted', 'partial', 'unknown') ORDER BY created_at ASC")
        .all() as readonly Record<string, unknown>[];
      return rows.map(toGuardOperation);
    },

    learn(lesson) {
      db.prepare(
        "INSERT OR IGNORE INTO lessons (symbol, text, learned_at, source) VALUES (?, ?, ?, ?)",
      ).run(lesson.symbol, lesson.text, lesson.learnedAt, lesson.source);
    },

    lessonsFor(symbol) {
      const rows = db
        .prepare("SELECT * FROM lessons WHERE symbol = ? OR symbol = '*' ORDER BY learned_at DESC")
        .all(symbol) as readonly Record<string, unknown>[];
      return rows.map(toLesson);
    },

    allLessons() {
      const rows = db
        .prepare("SELECT * FROM lessons ORDER BY learned_at DESC")
        .all() as readonly Record<string, unknown>[];
      return rows.map(toLesson);
    },
  };
}
