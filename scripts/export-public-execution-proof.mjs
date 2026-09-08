import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [databasePath, outputPath] = process.argv.slice(2);
if (!databasePath) {
  throw new Error("Usage: node scripts/export-public-execution-proof.mjs <database> [output]");
}

const sha256 = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

const iso = (value) =>
  value === null || value === undefined ? null : new Date(Number(value)).toISOString();

const ref = (value) =>
  value === null || value === undefined || value === ""
    ? null
    : `sha256:${sha256(value)}`;

const db = new DatabaseSync(databasePath, { readOnly: true });
const hasTable = (name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const rows = (query) => db.prepare(query).all();

const operations = hasTable("operations")
  ? rows(`SELECT p.symbol, p.side, p.order_type, p.mode,
                 o.client_order_id, o.exchange_order_ref, o.status,
                 o.filled_quantity, o.average_price, o.fee_paid,
                 o.submitted_at, o.reconciled_at, o.failure_code
          FROM operations o
          JOIN proposals p ON p.id = o.proposal_id
          ORDER BY COALESCE(o.reconciled_at, o.submitted_at) ASC`).map((row) => ({
      symbol: row.symbol,
      side: row.side,
      orderType: row.order_type,
      mode: row.mode,
      status: row.status,
      filledQuantity: row.filled_quantity,
      averagePrice: row.average_price,
      feePaid: row.fee_paid,
      submittedAt: iso(row.submitted_at),
      reconciledAt: iso(row.reconciled_at),
      failureCode: row.failure_code,
      clientOrderIdDigest: ref(row.client_order_id),
      exchangeOrderRefDigest: ref(row.exchange_order_ref),
    }))
  : [];

const guardOperations = hasTable("guard_operations")
  ? rows(`SELECT symbol, action, quantity, status, order_ref, filled_quantity,
                 client_order_id, created_at, updated_at
          FROM guard_operations ORDER BY created_at ASC`).map((row) => ({
      symbol: row.symbol,
      action: row.action,
      requestedQuantity: row.quantity,
      filledQuantity: row.filled_quantity,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      clientOrderIdDigest: ref(row.client_order_id),
      exchangeOrderRefDigest: ref(row.order_ref),
    }))
  : [];

const mandates = hasTable("protection_mandates")
  ? rows(`SELECT symbol, target_coverage_bps, tolerance_bps, max_notional,
                 leverage, max_adjustment_bps, version, created_at, expires_at,
                 cooldown_ms, status, last_action_at, checkpoint_at, last_state
          FROM protection_mandates ORDER BY created_at ASC`).map((row) => ({
      symbol: row.symbol,
      targetCoverageBps: row.target_coverage_bps,
      toleranceBps: row.tolerance_bps,
      maximumFuturesNotional: row.max_notional,
      leverage: row.leverage,
      maximumAdjustmentBps: row.max_adjustment_bps,
      version: row.version,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      cooldownMs: row.cooldown_ms,
      status: row.status,
      lastActionAt: iso(row.last_action_at),
      checkpointAt: iso(row.checkpoint_at),
      lastState: row.last_state,
    }))
  : [];

const journal = hasTable("journal")
  ? rows(`SELECT at, kind, symbol, headline, detail, evidence IS NOT NULL AS has_evidence
          FROM journal ORDER BY at ASC`).map((row) => ({
      at: iso(row.at),
      kind: row.kind,
      symbol: row.symbol,
      headline: row.headline,
      detail: String(row.detail).replace(/\b(?:order\s+)?\d{7,}\b/gi, "order [redacted]"),
      hasEvidence: Boolean(row.has_evidence),
    }))
  : [];

const record = {
  schema: "telt-public-execution-proof/v1",
  generatedAt: new Date().toISOString(),
  source: "Telt durable SQLite state",
  privacy: "Account identity, confirmation tokens, internal operation IDs, client order IDs and exchange order references are omitted or SHA-256 hashed.",
  claims: {
    completedDirectOrders: operations.filter((entry) => entry.status === "filled").length,
    completedGuardAdjustments: guardOperations.filter((entry) => entry.status === "filled").length,
    protectionMandates: mandates.length,
    journalEvents: journal.length,
  },
  operations,
  guardOperations,
  mandates,
  journal,
};

const canonical = JSON.stringify(record);
const proof = { ...record, recordDigest: `sha256:${sha256(canonical)}` };
const rendered = `${JSON.stringify(proof, null, 2)}\n`;

if (outputPath) writeFileSync(outputPath, rendered, { encoding: "utf8", flag: "wx" });
else process.stdout.write(rendered);
