/**
 * Funding readiness — the hand-off from disputes to underwriting.
 *
 * Recomputed after every round: a deleted item is removed from the bureau it
 * was deleted from, so readiness moves as disputes succeed. Gate thresholds
 * are FUNDED UP's own defaults, not any lender's published criteria; tune
 * them per lender program.
 */

import type { Bureau } from "@/types/credit-bureau";
import { BUREAUS, type TriBureauReport } from "@/lib/credit-report-import/types";
import type { DisputeItem } from "./types";

export interface ReadinessThresholds {
  minScore: number;
  maxUtilization: number; // 0–1
  maxInquiries12m: number;
  lateLookbackMonths: number;
}

export const DEFAULT_THRESHOLDS: ReadinessThresholds = {
  minScore: 680,
  maxUtilization: 0.3,
  maxInquiries12m: 3,
  lateLookbackMonths: 12,
};

export interface BureauReadiness {
  bureau: Bureau;
  score?: number;
  derogatories: number; // collections + charge-offs still reporting
  recentLates: number;
  utilization?: number;
  inquiries12m: number;
}

export interface Gate {
  id: "score" | "derogatories" | "recent_lates" | "utilization" | "inquiries";
  label: string;
  passed: boolean;
  detail: string;
}

export interface Readiness {
  score: number; // 0–100
  ready: boolean;
  bureaus: BureauReadiness[];
  gates: Gate[];
  nextActions: string[];
}

const DAY = 86_400_000;

export function computeReadiness(
  report: TriBureauReport,
  items: DisputeItem[] = [],
  asOf: Date = report.reportDate ?? new Date(),
  t: ReadinessThresholds = DEFAULT_THRESHOLDS,
): Readiness {
  const deleted = new Set(
    items
      .filter((i) => i.outcomes.includes("deleted"))
      .map((i) => `${i.tradelineKey ?? i.name}:${i.bureau}`),
  );
  const deletedInquiry = new Set(
    items
      .filter((i) => i.kind === "inquiry" && i.outcomes.includes("deleted"))
      .map((i) => `${i.name}:${i.bureau}`),
  );

  const lateCutoff = new Date(asOf.getTime() - t.lateLookbackMonths * 30.44 * DAY);
  const cutoffMonth = lateCutoff.toISOString().slice(0, 7);
  const inqCutoff = asOf.getTime() - 365 * DAY;

  const bureaus: BureauReadiness[] = BUREAUS.filter((b) => report.bureausPresent.includes(b)).map((b) => {
    let derogatories = 0;
    let recentLates = 0;
    let bal = 0;
    let lim = 0;
    for (const tl of report.tradelines) {
      const x = tl.bureaus[b];
      if (!x || deleted.has(`${tl.key}:${b}`)) continue;
      if (x.paymentStatus === "collection" || x.paymentStatus === "charge_off") derogatories++;
      recentLates += Object.entries(x.history).filter(
        ([m, s]) => m >= cutoffMonth && s.startsWith("late"),
      ).length;
      const revolving = ["credit_card", "revolving"].includes(x.accountType);
      const open = x.paymentStatus !== "closed" && !x.closedDate;
      if (revolving && open && x.creditLimit && x.creditLimit > 0) {
        bal += Math.max(0, x.balance ?? 0);
        lim += x.creditLimit;
      }
    }
    const inquiries12m = report.inquiries.filter(
      (q) =>
        q.bureau === b &&
        q.date &&
        q.date.getTime() >= inqCutoff &&
        !deletedInquiry.has(`${q.creditorName}:${b}`),
    ).length;
    return {
      bureau: b,
      score: report.scores[b],
      derogatories,
      recentLates,
      utilization: lim > 0 ? bal / lim : undefined,
      inquiries12m,
    };
  });

  const scores = bureaus.map((x) => x.score).filter((s): s is number => s !== undefined);
  const minScore = scores.length ? Math.min(...scores) : undefined;
  const derog = Math.max(0, ...bureaus.map((x) => x.derogatories));
  const lates = Math.max(0, ...bureaus.map((x) => x.recentLates));
  const utils = bureaus.map((x) => x.utilization).filter((u): u is number => u !== undefined);
  const util = utils.length ? Math.max(...utils) : undefined;
  const inq = Math.max(0, ...bureaus.map((x) => x.inquiries12m));
  const pct = (u: number) => `${Math.round(u * 100)}%`;

  const gates: Gate[] = [
    {
      id: "score",
      label: `All scores ${t.minScore}+`,
      passed: minScore !== undefined && minScore >= t.minScore,
      detail: minScore === undefined ? "No scores on file" : `Lowest score ${minScore}`,
    },
    {
      id: "derogatories",
      label: "No collections or charge-offs reporting",
      passed: derog === 0,
      detail: `${derog} on the worst bureau`,
    },
    {
      id: "recent_lates",
      label: `No late payments in ${t.lateLookbackMonths} months`,
      passed: lates === 0,
      detail: `${lates} on the worst bureau`,
    },
    {
      id: "utilization",
      label: `Revolving utilization under ${pct(t.maxUtilization)}`,
      passed: util === undefined || util < t.maxUtilization,
      detail: util === undefined ? "No open revolving limits" : `Highest ${pct(util)}`,
    },
    {
      id: "inquiries",
      label: `${t.maxInquiries12m} or fewer hard inquiries in 12 months`,
      passed: inq <= t.maxInquiries12m,
      detail: `${inq} on the worst bureau`,
    },
  ];

  // Weighted 0–100: score 35, derogatories 25, lates 15, utilization 15, inquiries 10.
  const scorePts = minScore === undefined ? 0 : Math.max(0, Math.min(1, (minScore - 500) / (t.minScore + 40 - 500))) * 35;
  const derogPts = Math.max(0, 1 - derog / 4) * 25;
  const latePts = Math.max(0, 1 - lates / 4) * 15;
  const utilPts = util === undefined ? 15 : Math.max(0, Math.min(1, (0.9 - util) / (0.9 - 0.1))) * 15;
  const inqPts = Math.max(0, 1 - Math.max(0, inq - t.maxInquiries12m) / 4) * 10;
  const score = Math.round(scorePts + derogPts + latePts + utilPts + inqPts);

  const nextActions: string[] = [];
  if (derog > 0) nextActions.push("Keep disputing or negotiating the remaining collections and charge-offs (pay-for-delete or goodwill for accurate ones).");
  if (lates > 0) nextActions.push("Dispute inaccurate recent lates; request goodwill removal for accurate ones.");
  if (util !== undefined && util >= t.maxUtilization) nextActions.push(`Pay revolving balances down below ${pct(t.maxUtilization)} (under 10% is ideal) before the statement dates.`);
  if (inq > t.maxInquiries12m) nextActions.push("Pause new applications until inquiries age; dispute any unauthorized ones.");
  if (minScore !== undefined && minScore < t.minScore) nextActions.push(`Re-pull reports after the current round to track scores toward ${t.minScore}.`);

  return { score, ready: gates.every((g) => g.passed), bureaus, gates, nextActions };
}
