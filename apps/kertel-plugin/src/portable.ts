/**
 * Carrying Kertel's working state between machines.
 *
 * Kertel's state lives in a local SQLite file. Open Claude Code on a different
 * laptop and that file does not exist, so the monitor sits idle over a live
 * position it knows nothing about. This module is what makes the agent portable
 * rather than the machine: a snapshot goes into the user's own memory service,
 * and a restore on any other machine picks the positions back up mid-flight.
 *
 * Two rules shape everything below, and they are the difference between this
 * being useful and being dangerous.
 *
 * **The snapshot is intent. The exchange is truth.** A snapshot written on
 * Tuesday says Kertel was managing 0.3 ETH. By Thursday the account may hold
 * none of it — sold by hand, moved, or already exited by the machine that wrote
 * the snapshot. So restore rebuilds what was *intended*, checks it against what
 * is actually held, and reports the drift. It never silently starts managing a
 * position that is not there.
 *
 * **A restore never weakens safety.** The kill switch is not carried. If this
 * machine is stopped, a snapshot from a machine that was running does not start
 * it; an operator does. Restoring a "safe" flag would mean an old note could
 * quietly re-arm an agent somebody deliberately halted.
 *
 * The format is plain lines rather than JSON. It goes through a memory service
 * as text, gets read by humans deciding whether to trust it, and survives being
 * quoted in a chat window — none of which JSON does well. Every value is a
 * decimal string or an integer, so nothing is lost in the round trip.
 */

import * as fp from "@kertel/core/money";
import { formatInstant, utcDay } from "@kertel/core/domain";
import type { Instant, ProposalId, SenderIdHash, Symbol_ } from "@kertel/core/domain";
import type { ExitMandate, LadderRung, MandateId } from "@kertel/core/mandates";

import type { BinanceClient } from "./infra/binance.js";
import type { Store } from "./infra/store.js";

const FORMAT = "KERTEL-STATE-1";

export type PortableDeps = {
  readonly store: Store;
  readonly binance: BinanceClient;
  readonly now: () => Instant;
  readonly ownerHash: string | null;
  /** Names the writer, so a restore can tell "my own note" from "another machine's". */
  readonly machineId: string;
};

function ladderText(ladder: readonly LadderRung[]): string {
  return ladder.length === 0
    ? "-"
    : ladder.map((rung) => `${String(rung.atBps)}:${String(rung.fractionBps)}`).join(",");
}

function parseLadder(raw: string): LadderRung[] {
  if (raw === "-" || raw.trim() === "") {
    return [];
  }
  const rungs: LadderRung[] = [];
  for (const part of raw.split(",")) {
    const [at, fraction] = part.split(":");
    const atBps = Number(at);
    const fractionBps = Number(fraction);
    if (Number.isInteger(atBps) && Number.isInteger(fractionBps) && atBps > 0 && fractionBps > 0) {
      rungs.push({ atBps, fractionBps });
    }
  }
  return rungs;
}

function field(parts: readonly string[], key: string): string | null {
  const hit = parts.find((part) => part.startsWith(`${key}=`));
  return hit === undefined ? null : hit.slice(key.length + 1);
}

function optionalInt(value: string | null): number | null {
  if (value === null || value === "-") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Everything needed to pick these positions up somewhere else.
 *
 * Only live plans are carried. A completed or cancelled one is history, and
 * history belongs in the digest, not in the state a monitor is about to act on.
 */
export function snapshot(deps: PortableDeps): string {
  const now = deps.now();
  const lines: string[] = [];

  lines.push(`${FORMAT} written=${formatInstant(now)} machine=${deps.machineId}`);
  lines.push(`# Kertel working state. Hand this to kertel_restore on any machine to resume.`);
  lines.push(`# Positions are re-checked against the exchange on restore; this is intent, not truth.`);
  lines.push("");

  const live = deps.store.mandates
    .all()
    .filter((mandate) => mandate.status === "active" || mandate.status === "pending");

  if (live.length === 0) {
    lines.push("# No positions are being managed.");
  }
  for (const mandate of live) {
    lines.push(
      [
        "PLAN",
        `id=${mandate.id}`,
        `symbol=${mandate.symbol}`,
        `status=${mandate.status}`,
        `entry=${fp.format(mandate.entryPrice)}`,
        `qty=${fp.format(mandate.quantity)}`,
        `sold=${fp.format(mandate.soldQuantity)}`,
        `soldbps=${String(mandate.soldBps)}`,
        // The ratchet. Losing this on a move would reset a trailing stop to its
        // starting point and hand back everything the position had earned.
        `peak=${String(mandate.highWaterBps)}`,
        `ladder=${ladderText(mandate.ladder)}`,
        `stop=${mandate.stopLossBps === null ? "-" : String(mandate.stopLossBps)}`,
        `trailat=${mandate.trailing === null ? "-" : String(mandate.trailing.activateAtBps)}`,
        `trailby=${mandate.trailing === null ? "-" : String(mandate.trailing.trailBps)}`,
        `be=${mandate.breakevenAtBps === null ? "-" : String(mandate.breakevenAtBps)}`,
        `created=${String(mandate.createdAt)}`,
        `expires=${String(mandate.expiresAt)}`,
      ].join(" "),
    );
  }

  const outcomes = deps.store.mandates.outcomes(50);
  if (outcomes.length > 0) {
    lines.push("");
    for (const outcome of outcomes) {
      lines.push(
        [
          "OUTCOME",
          `at=${String(outcome.at)}`,
          `symbol=${outcome.symbol}`,
          `reason=${outcome.reason}`,
          `entry=${outcome.entryPrice}`,
          `exit=${outcome.exitPrice}`,
          `qty=${outcome.quantity}`,
          `move=${String(outcome.moveBps)}`,
          `peak=${String(outcome.peakBps)}`,
          `recovered=${outcome.recoveredWithin24h === null ? "-" : outcome.recoveredWithin24h ? "1" : "0"}`,
        ].join(" "),
      );
    }
  }

  const lessons = deps.store.mandates.allLessons();
  if (lessons.length > 0) {
    lines.push("");
    for (const lesson of lessons) {
      // Tabs, because a lesson is a sentence and will contain spaces.
      lines.push(`LESSON\t${lesson.symbol}\t${lesson.learnedAt}\t${lesson.text.replace(/\s+/g, " ")}`);
    }
  }

  const spentToday = deps.store.spentOn(now);
  if (fp.isPositive(spentToday)) {
    lines.push("");
    lines.push(`SPEND day=${utcDay(now)} amount=${fp.format(fp.trim(spentToday, 2))}`);
  }

  return lines.join("\n");
}

export type RestoreReport = {
  readonly ok: boolean;
  readonly body: string;
};

/**
 * Rebuild the working state, then check it against reality.
 *
 * Restoring is deliberately not a database import. Each plan is re-derived,
 * re-verified against the balance that actually exists, and reported on. A plan
 * whose position is gone comes back marked unfulfillable rather than as
 * something the monitor will try to sell.
 */
export async function restore(deps: PortableDeps, text: string): Promise<RestoreReport> {
  const now = deps.now();
  const lines = text.split("\n").map((line) => line.trim());

  const header = lines.find((line) => line.startsWith(FORMAT));
  if (header === undefined) {
    return {
      ok: false,
      body: `That does not look like a Kertel snapshot. It should begin with ${FORMAT}.`,
    };
  }

  const writtenBy = field(header.split(" "), "machine");
  const writtenAt = field(header.split(" "), "written");

  if (deps.ownerHash === null) {
    return { ok: false, body: "Kertel has no configured owner, so it will not restore state." };
  }

  const restored: string[] = [];
  const drifted: string[] = [];
  const skipped: string[] = [];
  let outcomeCount = 0;
  let lessonCount = 0;

  for (const line of lines) {
    if (line.startsWith("PLAN ")) {
      const parts = line.split(" ");
      const id = field(parts, "id");
      const symbol = field(parts, "symbol");
      const entry = field(parts, "entry");
      const qty = field(parts, "qty");
      if (id === null || symbol === null || entry === null || qty === null) {
        skipped.push("a PLAN line was missing required fields");
        continue;
      }

      // Already here. Restoring over a live plan would reset its peak and its
      // sold total, which is how a trailing stop silently loses its ratchet.
      if (deps.store.mandates.find(id) !== null) {
        skipped.push(`${symbol}: already managed here (${id})`);
        continue;
      }

      const mandate: ExitMandate = {
        id: id as MandateId,
        senderIdHash: deps.ownerHash as SenderIdHash,
        symbol: symbol as Symbol_,
        entryPrice: fp.parse(entry),
        quantity: fp.parse(qty),
        soldQuantity: fp.parse(field(parts, "sold") ?? "0"),
        soldBps: optionalInt(field(parts, "soldbps")) ?? 0,
        highWaterBps: optionalInt(field(parts, "peak")) ?? 0,
        ladder: parseLadder(field(parts, "ladder") ?? "-"),
        stopLossBps: optionalInt(field(parts, "stop")),
        trailing: (() => {
          const at = optionalInt(field(parts, "trailat"));
          const by = optionalInt(field(parts, "trailby"));
          return at === null || by === null ? null : { activateAtBps: at, trailBps: by };
        })(),
        breakevenAtBps: optionalInt(field(parts, "be")),
        createdAt: (optionalInt(field(parts, "created")) ?? now) as Instant,
        expiresAt: (optionalInt(field(parts, "expires")) ?? now) as Instant,
        // A pending plan is one nobody armed. It does not become armed by
        // travelling to another machine.
        status: field(parts, "status") === "pending" ? "pending" : "active",
        sourceProposalId: null as ProposalId | null,
      };

      if (mandate.expiresAt <= now) {
        deps.store.mandates.save({ ...mandate, status: "expired" }, null, null);
        skipped.push(`${symbol}: the plan had already expired`);
        continue;
      }

      // Intent is rebuilt; now check it against what is actually held.
      const [filtersResult, accountResult] = await Promise.all([
        deps.binance.filters(mandate.symbol),
        deps.binance.account(),
      ]);

      let note = "";
      let status = mandate.status;
      if (filtersResult.ok && accountResult.ok) {
        const base = filtersResult.value.baseAsset;
        const held =
          accountResult.value.balances.find((balance) => balance.asset === base)?.free ??
          fp.parse("0");
        const expected = fp.subtract(mandate.quantity, mandate.soldQuantity);

        if (!fp.isPositive(held)) {
          status = "unfulfillable";
          note = `the account holds no ${base}, so there is nothing left to manage`;
          drifted.push(`${symbol}: ${note}`);
        } else if (fp.lessThan(held, expected)) {
          note = `expected ${fp.format(expected)} ${base}, found ${fp.format(held)} — the plan will only ever sell what is there`;
          drifted.push(`${symbol}: ${note}`);
        }
      } else {
        note = "could not reach the exchange to verify the position";
        drifted.push(`${symbol}: ${note}`);
      }

      deps.store.mandates.save({ ...mandate, status }, null, null);
      if (status === "active") {
        restored.push(
          `${symbol}: ${fp.format(fp.subtract(mandate.quantity, mandate.soldQuantity))} left, peak +${String(mandate.highWaterBps / 100)}%`,
        );
      }
      deps.store.mandates.journal({
        at: now,
        kind: "mandate_created",
        symbol: mandate.symbol,
        mandateId: mandate.id,
        headline: `Resumed managing ${mandate.symbol} from a snapshot`,
        detail:
          note === ""
            ? `Carried from ${writtenBy ?? "another machine"}, written ${writtenAt ?? "at an unknown time"}.`
            : `Carried from ${writtenBy ?? "another machine"}; ${note}.`,
        evidence: null,
      });
      continue;
    }

    if (line.startsWith("OUTCOME ")) {
      const parts = line.split(" ");
      const at = optionalInt(field(parts, "at"));
      const symbol = field(parts, "symbol");
      if (at === null || symbol === null) {
        continue;
      }
      const recovered = field(parts, "recovered");
      deps.store.mandates.recordOutcome({
        at: at as Instant,
        symbol,
        mandateId: "restored",
        reason: field(parts, "reason") ?? "unknown",
        entryPrice: field(parts, "entry") ?? "0",
        exitPrice: field(parts, "exit") ?? "0",
        quantity: field(parts, "qty") ?? "0",
        moveBps: optionalInt(field(parts, "move")) ?? 0,
        peakBps: optionalInt(field(parts, "peak")) ?? 0,
        recoveredWithin24h: recovered === "-" || recovered === null ? null : recovered === "1",
      });
      outcomeCount += 1;
      continue;
    }

    if (line.startsWith("LESSON\t")) {
      const [, symbol, learnedAt, ...rest] = line.split("\t");
      const body = rest.join("\t").trim();
      if (symbol === undefined || body === "") {
        continue;
      }
      deps.store.mandates.learn({
        symbol,
        text: body,
        learnedAt: (optionalInt(learnedAt ?? null) ?? now) as Instant,
        source: "recalled",
      });
      lessonCount += 1;
    }
  }

  const report: string[] = ["Restored from snapshot", ""];
  report.push(`Written ${writtenAt ?? "at an unknown time"} by ${writtenBy ?? "an unnamed machine"}.`);
  report.push("");

  if (restored.length > 0) {
    report.push("Now managing again:");
    for (const line of restored) {
      report.push(`  ${line}`);
    }
    report.push("");
  }
  if (drifted.length > 0) {
    // The whole reason restore is not a database import.
    report.push("Drifted since the snapshot was written:");
    for (const line of drifted) {
      report.push(`  ${line}`);
    }
    report.push("");
  }
  if (skipped.length > 0) {
    report.push("Not restored:");
    for (const line of skipped) {
      report.push(`  ${line}`);
    }
    report.push("");
  }

  report.push(
    `Also carried: ${String(outcomeCount)} past exit(s) and ${String(lessonCount)} lesson(s).`,
  );

  if (writtenBy !== null && writtenBy !== deps.machineId && restored.length > 0) {
    report.push("");
    report.push(
      "NOTE: this snapshot was written by a different machine. If that one is still running,",
    );
    report.push(
      "two copies of Kertel now hold the same plans. An autonomous exit derives its order id",
    );
    report.push(
      "from the plan's state, so a duplicate would collide at the exchange — but do not rely on",
    );
    report.push("that. Stop the other one, or cancel these plans there.");
  }

  report.push("");
  report.push("The kill switch was not carried: safety is per machine and is never restored on.");

  return { ok: true, body: report.join("\n") };
}
