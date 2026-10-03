/**
 * Round planner and outcome tracking.
 *
 * Round 1: every confirmed item, to each bureau reporting it, plus a direct
 * letter to each furnisher/collector.
 * Round 2 and 3: only items still "verified" or with no response. Items the
 * bureau "updated" go back to the client to confirm the update fixed them.
 * After Round 3: remaining items are flagged for a CFPB complaint and
 * attorney review instead of a fourth identical letter.
 */

import type { Bureau } from "@/types/credit-bureau";
import { BUREAUS } from "@/lib/credit-report-import/types";
import { bureauLetter, furnisherLetter } from "./letters";
import type {
  Consumer,
  DisputeItem,
  Outcome,
  Recipient,
  Round,
  RoundPlan,
  RoundTimeline,
} from "./types";

const DAY = 86_400_000;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
}

/**
 * §1681i(a)(1)(A): 30 days from the bureau's receipt (+15 if the consumer
 * sends more information during the period). We assume 5 days in the mail.
 */
export function roundTimeline(round: Round, mailedOn: string): RoundTimeline {
  const received = addDays(mailedOn, 5);
  return {
    round,
    mailedOn,
    responseDueOn: addDays(received, 30),
    extendedDueOn: addDays(received, 45),
    nextRoundEligibleOn: addDays(mailedOn, 45),
  };
}

function eligible(item: DisputeItem, round: Round): { ok: boolean; why?: string } {
  if (!item.confirmedByClient) return { ok: false, why: "Not confirmed by client as inaccurate." };
  const done = item.outcomes.length;
  if (round === 1) {
    return done === 0 ? { ok: true } : { ok: false, why: "Already disputed in Round 1." };
  }
  if (done !== round - 1) {
    return { ok: false, why: `Needs a Round ${round - 1} outcome before Round ${round}.` };
  }
  const last = item.outcomes[done - 1];
  if (last === "deleted") return { ok: false, why: "Deleted." };
  if (last === "pending") return { ok: false, why: "Waiting on the bureau's response." };
  if (last === "updated") {
    return { ok: false, why: "Updated by the bureau; client to confirm whether the update fixed it." };
  }
  return { ok: true };
}

export interface PlanOptions {
  consumer: Consumer;
  date: Date;
  /** Known dispute addresses for furnishers/collectors, keyed by name. */
  furnisherAddresses?: Record<string, Recipient>;
}

export function planRound(items: DisputeItem[], round: Round, opts: PlanOptions): RoundPlan {
  const plan: RoundPlan = { round, letters: [], skipped: [] };
  const go: DisputeItem[] = [];
  for (const item of items) {
    const e = eligible(item, round);
    if (e.ok) go.push(item);
    else plan.skipped.push({ itemId: item.id, reason: e.why! });
  }

  // Bureau letters: one per bureau, in a fixed order, distinct variants.
  BUREAUS.forEach((bureau: Bureau, i) => {
    const forBureau = go.filter((it) => it.bureau === bureau);
    if (forBureau.length) {
      plan.letters.push(bureauLetter(bureau, forBureau, round, opts.consumer, opts.date, i + round));
    }
  });

  // Direct furnisher/collector letters: accounts only, one per company.
  const byCompany = new Map<string, DisputeItem[]>();
  for (const it of go) {
    if (it.kind !== "account") continue;
    // Disputing "not on another bureau" alone isn't a furnisher error.
    if (it.reasons.every((r) => r === "missing_on_bureau")) continue;
    byCompany.set(it.name, [...(byCompany.get(it.name) ?? []), it]);
  }
  [...byCompany.entries()].forEach(([name, list], i) => {
    plan.letters.push(
      furnisherLetter(name, list, round, opts.consumer, opts.date, i + round, opts.furnisherAddresses?.[name]),
    );
  });

  return plan;
}

/** Record a bureau's result for items in the round just mailed. */
export function recordOutcomes(
  items: DisputeItem[],
  results: Record<string, Outcome>,
  responseDate?: string,
): DisputeItem[] {
  return items.map((it) => {
    const outcome = results[it.id];
    if (!outcome) return it;
    const outcomes = [...it.outcomes];
    if (outcomes[outcomes.length - 1] === "pending") outcomes[outcomes.length - 1] = outcome;
    else outcomes.push(outcome);
    return { ...it, outcomes, lastResponseDate: responseDate ?? it.lastResponseDate };
  });
}

/** Mark the items in a plan as mailed (outcome pending). */
export function markMailed(items: DisputeItem[], plan: RoundPlan): DisputeItem[] {
  const ids = new Set(plan.letters.flatMap((l) => l.itemIds));
  return items.map((it) => (ids.has(it.id) ? { ...it, outcomes: [...it.outcomes, "pending" as Outcome] } : it));
}

/** Items that survived Round 3 — candidates for a CFPB complaint and attorney review. */
export function escalationCandidates(items: DisputeItem[]): DisputeItem[] {
  return items.filter((it) => {
    const last = it.outcomes[2];
    return last === "verified" || last === "no_response";
  });
}
