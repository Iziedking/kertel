/**
 * A verdict Telt is willing to act on unattended.
 *
 * When a human is present, the model reasons and the human decides. When Telt
 * hunts at four in the morning there is no human, so the model's answer becomes
 * the decision — and that changes what an answer is allowed to look like.
 *
 * A model asked "should I buy this" will always produce prose, and prose always
 * sounds reasonable. So the only thing accepted here is a small closed
 * structure that can be checked mechanically, and every field exists to make a
 * particular failure impossible:
 *
 * - **`action` is one of three words.** Not a paragraph that has to be
 *   interpreted, because interpreting a paragraph is where an agent talks
 *   itself into a trade.
 * - **`confidence` is a number and there is a floor.** A model that is unsure
 *   says so, and unsure is not a reason to spend money.
 * - **`because` must cite the evidence.** A verdict that could have been
 *   written without reading the research is a verdict that was.
 * - **`risks` must not be empty.** Anything worth buying has something wrong
 *   with it, and a model that lists none has not looked. This is the field that
 *   catches enthusiasm.
 * - **Everything is stored and signed.** The verdict goes into the attestation
 *   alongside the evidence it was drawn from, so the reasoning behind an
 *   unattended trade is as checkable afterwards as the payment for it.
 *
 * Nothing here decides whether a model is *right*. It decides whether an answer
 * is well-formed enough to be worth acting on, and rejects the rest.
 */

export type VerdictAction = "BUY_CANDIDATE" | "NO_TRADE" | "INSUFFICIENT_EVIDENCE";

export type Verdict = {
  readonly action: VerdictAction;
  /** 0 to 100. Below the floor, Telt does not act however good the prose is. */
  readonly confidence: number;
  /** Why, citing what was actually read. */
  readonly because: string;
  /** What is wrong with it. Never empty for a buy. */
  readonly risks: readonly string[];
};

/**
 * The confidence below which Telt will not act unattended.
 *
 * Set where it is because the cost of a missed opportunity is nothing and the
 * cost of a bad unattended trade is money plus trust. Seventy is not a claim
 * about calibration — models are not calibrated — it is a deliberately high bar
 * that a genuinely marginal case will not clear.
 */
export const CONFIDENCE_FLOOR = 70;

/** The shortest `because` that could plausibly reference real evidence. */
const MIN_REASON_CHARS = 40;

export type VerdictProblem = string;

/**
 * Read a model's answer, or say why it cannot be used.
 *
 * Returns problems rather than throwing, and a malformed verdict is simply not
 * acted on: the run is journalled as "looked, did not act, here is why" and the
 * budget is untouched. A model having a bad day must cost nothing.
 */
export function parseVerdict(raw: unknown): { verdict: Verdict | null; problems: readonly VerdictProblem[] } {
  const problems: VerdictProblem[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { verdict: null, problems: ["The model did not answer with an object."] };
  }
  const record = raw as Record<string, unknown>;

  const action = record["action"];
  if (action !== "BUY_CANDIDATE" && action !== "NO_TRADE" && action !== "INSUFFICIENT_EVIDENCE") {
    problems.push(`action was ${JSON.stringify(action)}, which is not one of the three allowed answers.`);
  }

  const confidenceRaw = record["confidence"];
  const confidence =
    typeof confidenceRaw === "number"
      ? confidenceRaw
      : typeof confidenceRaw === "string" && /^\d+(\.\d+)?$/.test(confidenceRaw)
        ? Number(confidenceRaw)
        : null;
  if (confidence === null || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    problems.push("confidence was not a number between 0 and 100.");
  }

  const because = typeof record["because"] === "string" ? record["because"].trim() : "";
  if (because.length < MIN_REASON_CHARS) {
    problems.push(
      "because was too short to be a reason drawn from the evidence. A verdict that could have been written without reading the research was.",
    );
  }

  const risksRaw = record["risks"];
  const risks = Array.isArray(risksRaw)
    ? risksRaw.filter((risk): risk is string => typeof risk === "string" && risk.trim() !== "")
    : [];
  if (action === "BUY_CANDIDATE" && risks.length === 0) {
    problems.push(
      "risks was empty on a buy. Everything worth buying has something wrong with it, and a model that lists none has not looked.",
    );
  }

  if (problems.length > 0) {
    return { verdict: null, problems };
  }

  return {
    verdict: {
      action: action as VerdictAction,
      confidence: confidence ?? 0,
      because,
      risks: Object.freeze(risks.map((risk) => risk.trim())),
    },
    problems: [],
  };
}

/** Whether this verdict may move money with nobody watching. */
export function actionable(verdict: Verdict): { readonly act: boolean; readonly because: string } {
  if (verdict.action !== "BUY_CANDIDATE") {
    return {
      act: false,
      because:
        verdict.action === "NO_TRADE"
          ? "The evidence did not support a trade."
          : "The evidence was not strong enough to conclude anything.",
    };
  }
  if (verdict.confidence < CONFIDENCE_FLOOR) {
    return {
      act: false,
      because: `Confidence was ${String(Math.round(verdict.confidence))}, below the ${String(CONFIDENCE_FLOOR)} floor for acting unattended. Worth telling you about; not worth spending on.`,
    };
  }
  return { act: true, because: `A ${String(Math.round(verdict.confidence))}-confidence buy with ${String(verdict.risks.length)} stated risk${verdict.risks.length === 1 ? "" : "s"}.` };
}

/**
 * The instruction the model answers.
 *
 * Written to make refusing easy. A prompt that asks "is this a good trade"
 * invites a yes; this one puts the burden on the evidence and says plainly that
 * declining is a good outcome, because the alternative is an agent that finds a
 * reason to trade every time it looks.
 */
export function verdictInstruction(): string {
  return [
    "You are the reasoning layer of an autonomous trading agent that has already paid for the",
    "evidence below out of its own wallet. Your answer decides whether real money moves, with",
    "nobody watching and nobody to correct you.",
    "",
    "Answer ONLY with a JSON object:",
    '  {"action": "BUY_CANDIDATE" | "NO_TRADE" | "INSUFFICIENT_EVIDENCE",',
    '   "confidence": <0-100>,',
    '   "because": "<why, citing the specific numbers you read>",',
    '   "risks": ["<what is wrong with this>", ...]}',
    "",
    "Rules that matter more than being helpful:",
    "- NO_TRADE is a good answer. Most looks should end in one. You are not being graded on",
    "  finding something.",
    "- INSUFFICIENT_EVIDENCE when a source was unreadable or a source refused. Do not fill the",
    "  gap with what you already know about the asset; the whole point is that this decision",
    "  rests on evidence that was paid for and can be checked.",
    "- `because` must cite actual figures from the evidence. A reason that would read the same",
    "  for any token is not a reason.",
    "- `risks` must never be empty for a BUY_CANDIDATE. If you cannot name what could go wrong,",
    "  you have not understood the trade well enough to make it.",
    "- Confidence is not enthusiasm. Below 70 nothing will happen, which is the correct outcome",
    "  for anything genuinely marginal.",
  ].join("\n");
}
