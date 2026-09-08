import { createHash } from "node:crypto";
import type {
  DecisionInput,
  DecisionRecord,
  ResearchStore,
} from "./infra/research-store.js";

export function decisionDigest(input: DecisionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "telt.decision.v1",
        run: input.researchRunId,
        recommendation: input.recommendation,
        summary: input.summary,
        evidence: [...input.supportingEvidence].sort(),
        invalidatedBy: input.invalidatedBy,
        model: input.modelId,
      }),
    )
    .digest("hex");
}

export function recordDecision(
  store: ResearchStore,
  input: DecisionInput,
  now: number,
):
  | { ok: true; body: string; decisionId: string }
  | { ok: false; body: string } {
  const run = store.find(input.researchRunId);
  if (run === null || now >= run.expiresAt || now < run.createdAt) {
    return {
      ok: false,
      body: "Research is missing or stale. Run fresh research before recording a decision.",
    };
  }
  if (
    !["BUY_CANDIDATE", "NO_TRADE", "INSUFFICIENT_EVIDENCE"].includes(
      input.recommendation,
    ) ||
    input.summary.trim().length < 10 ||
    input.summary.length > 2000 ||
    input.modelId.trim() === "" ||
    input.modelId.length > 120 ||
    input.supportingEvidence.length === 0 ||
    input.supportingEvidence.length > 20 ||
    input.supportingEvidence.some((id) => !run.evidenceIds.includes(id)) ||
    input.invalidatedBy.length === 0 ||
    input.invalidatedBy.length > 10 ||
    input.invalidatedBy.some(
      (reason) => reason.trim() === "" || reason.length > 500,
    )
  ) {
    return {
      ok: false,
      body: "A decision needs a concise rationale, evidence IDs from this run, its reasoning source, and conditions that would invalidate it.",
    };
  }
  const digest = decisionDigest(input);
  const id = `decision-${digest}`;
  const decision: DecisionRecord = { ...input, id, digest, createdAt: now };
  if (store.findDecision(id) === null) store.saveDecision(decision);
  return {
    ok: true,
    decisionId: id,
    body: [
      `Decision: ${input.recommendation}`,
      input.summary,
      `Research run: ${run.id}`,
      `Evidence: ${input.supportingEvidence.join(", ")}`,
      `Invalidated by: ${input.invalidatedBy.join("; ")}`,
      `Decision ID: ${id}`,
      "This records the reasoning supplied by the client. It does not validate a prediction or authorize an order.",
    ].join("\n"),
  };
}
