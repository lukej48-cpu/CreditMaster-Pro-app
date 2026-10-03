/**
 * FUNDED UP firm workflow — pure logic behind the staff "one button" dispute
 * package. Routes call these and handle storage.
 */

import { createHash } from "node:crypto";
import {
  analyzeCrossBureau,
  parseThreeBureauHtml,
  summarizeImport,
  type Discrepancy,
  type TriBureauReport,
} from "@/lib/credit-report-import";
import {
  buildDisputeItems,
  computeReadiness,
  escalationCandidates,
  leadId,
  markMailed,
  planRound,
  recordOutcomes,
  roundTimeline,
  type ClientClaim,
  type Consumer,
  type DisputeItem,
  type Outcome,
  type Round,
  type RoundPlan,
  type RoundTimeline,
} from "@/lib/dispute-engine";
import { reportFromJson, reportToJson } from "@/lib/dispute-engine/serialize";

export interface FirmClient {
  id: string;
  owner_id: string;
  full_name: string;
  address_lines: string[];
  state: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface RoundLog {
  round: Round;
  mailedOn: string;
  itemIds: string[];
  recipients: string[];
}

export interface CaseRow {
  client_id: string;
  owner_id: string;
  report: unknown | null;
  report_sha256: string | null;
  leads: Array<Discrepancy & { id: string }>;
  items: DisputeItem[];
  rounds: RoundLog[];
}

export class CaseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function toConsumer(c: FirmClient): Consumer {
  if (!c.address_lines?.length) {
    throw new CaseError("Add the client's mailing address before generating letters.");
  }
  return { fullName: c.full_name, addressLines: c.address_lines, state: c.state ?? "" };
}

/** Parse an uploaded report into the case's report + leads. Resets items. */
export function caseFromUpload(bytes: Buffer, html: string) {
  const report = parseThreeBureauHtml(html);
  const leads = analyzeCrossBureau(report).map((d) => ({ ...d, id: leadId(d) }));
  return {
    report: reportToJson(report),
    report_sha256: createHash("sha256").update(bytes).digest("hex"),
    leads,
    items: [] as DisputeItem[],
    rounds: [] as RoundLog[],
    summary: summarizeImport(report, leads),
  };
}

export function nextRound(row: CaseRow): Round | null {
  const done = row.rounds.length;
  if (done >= 3) return null;
  if (done === 0) return 1;
  // A later round needs every mailed item to have a recorded result.
  const pending = row.items.some((i) => i.outcomes[i.outcomes.length - 1] === "pending");
  return pending ? null : ((done + 1) as Round);
}

export interface PackageInput {
  round: Round;
  confirmedLeadIds?: string[];
  claims?: ClientClaim[];
  date: Date;
}

export function generatePackage(
  row: CaseRow,
  client: FirmClient,
  input: PackageInput,
): { plan: RoundPlan; items: DisputeItem[]; rounds: RoundLog[]; timeline: RoundTimeline } {
  if (!row.report) throw new CaseError("Upload the client's 3-bureau report first.");
  const expected = nextRound(row);
  if (expected === null) {
    throw new CaseError(
      row.rounds.length >= 3
        ? "All three rounds have been mailed. Remaining items go to CFPB complaint and attorney review."
        : "Record the bureau results for the last round before generating the next one.",
      409,
    );
  }
  if (input.round !== expected) {
    throw new CaseError(`This client's next round is Round ${expected}.`, 409);
  }

  const report: TriBureauReport = reportFromJson(row.report);
  let items = row.items;
  if (input.round === 1) {
    const known = new Set(row.leads.map((l) => l.id));
    const confirmed = (input.confirmedLeadIds ?? []).filter((id) => known.has(id));
    if (!confirmed.length && !(input.claims ?? []).length) {
      throw new CaseError("Confirm at least one item with the client before generating Round 1.");
    }
    items = buildDisputeItems(report, row.leads, confirmed, input.claims ?? []);
  }

  const plan = planRound(items, input.round, { consumer: toConsumer(client), date: input.date });
  if (!plan.letters.length) throw new CaseError("No items are eligible for this round.", 409);

  const mailedOn = input.date.toISOString().slice(0, 10);
  const timeline = roundTimeline(input.round, mailedOn);
  return {
    plan,
    items: markMailed(items, plan),
    rounds: [
      ...row.rounds,
      {
        round: input.round,
        mailedOn,
        itemIds: plan.letters.flatMap((l) => l.itemIds),
        recipients: plan.letters.map((l) => l.recipient.name),
      },
    ],
    timeline,
  };
}

const OUTCOMES: Outcome[] = ["deleted", "updated", "verified", "no_response"];

export function applyOutcomes(
  row: CaseRow,
  results: Record<string, string>,
  responseDate?: string,
): DisputeItem[] {
  const ids = new Set(row.items.map((i) => i.id));
  const clean: Record<string, Outcome> = {};
  for (const [id, v] of Object.entries(results)) {
    if (!ids.has(id)) throw new CaseError(`Unknown item ${id}.`);
    if (!OUTCOMES.includes(v as Outcome)) throw new CaseError(`Invalid result "${v}" for ${id}.`);
    const last = row.items.find((i) => i.id === id)!.outcomes.at(-1);
    if (last !== "pending") throw new CaseError(`Item ${id} has no round awaiting a result.`);
    clean[id] = v as Outcome;
  }
  if (responseDate && !/^\d{2}\/\d{2}\/\d{4}$/.test(responseDate)) {
    throw new CaseError("Response date must be MM/DD/YYYY.");
  }
  return recordOutcomes(row.items, clean, responseDate);
}

/** Everything the staff screen shows for a client. */
export function caseView(row: CaseRow | null) {
  if (!row?.report) {
    return { hasReport: false, leads: [], items: [], rounds: [], nextRound: null, readiness: null, summary: null, escalate: [] };
  }
  const report = reportFromJson(row.report);
  return {
    hasReport: true,
    summary: summarizeImport(report, row.leads),
    leads: row.leads,
    items: row.items,
    rounds: row.rounds,
    nextRound: nextRound(row),
    readiness: computeReadiness(report, row.items),
    escalate: escalationCandidates(row.items).map((i) => i.id),
  };
}
