import type { DatabaseSync } from "node:sqlite";

export type ResearchRecord = {
  readonly id: string;
  readonly symbol: string;
  readonly mode: "fixture" | "live";
  readonly goal: "price_check" | "trade_thesis";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly policyVersion: string;
  readonly provenance: string;
  readonly evidenceIds: readonly string[];
  readonly body: string;
};

export type DecisionInput = {
  readonly researchRunId: string;
  readonly recommendation:
    | "BUY_CANDIDATE"
    | "NO_TRADE"
    | "INSUFFICIENT_EVIDENCE";
  readonly summary: string;
  readonly supportingEvidence: readonly string[];
  readonly invalidatedBy: readonly string[];
  readonly modelId: string;
};

export type DecisionRecord = DecisionInput & {
  readonly id: string;
  readonly digest: string;
  readonly createdAt: number;
};

export type ResearchStore = {
  save(run: ResearchRecord): void;
  find(id: string): ResearchRecord | null;
  saveDecision(decision: DecisionRecord): void;
  findDecision(id: string): DecisionRecord | null;
};

/** Immutable records; a revised conclusion gets a new identity and confirmation. */
export function researchStore(db: DatabaseSync): ResearchStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_runs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_decisions (id TEXT PRIMARY KEY, document TEXT NOT NULL);
  `);
  function find<T>(
    table: "research_runs" | "research_decisions",
    id: string,
  ): T | null {
    const row = db
      .prepare(`SELECT document FROM ${table} WHERE id = ?`)
      .get(id);
    return row === undefined
      ? null
      : (JSON.parse(String(row["document"])) as T);
  }
  return {
    save: (run) => {
      db.prepare("INSERT INTO research_runs (id, document) VALUES (?, ?)").run(
        run.id,
        JSON.stringify(run),
      );
    },
    find: (id) => find<ResearchRecord>("research_runs", id),
    saveDecision: (decision) => {
      db.prepare(
        "INSERT INTO research_decisions (id, document) VALUES (?, ?)",
      ).run(decision.id, JSON.stringify(decision));
    },
    findDecision: (id) => find<DecisionRecord>("research_decisions", id),
  };
}
