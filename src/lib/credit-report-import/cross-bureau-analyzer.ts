/**
 * Cross-Bureau Analyzer
 *
 * Compares how TransUnion, Experian and Equifax report the same consumer and
 * produces Discrepancy leads for the dispute engine. The same account can't
 * be accurate on all three bureaus if they disagree about it, so
 * inconsistencies are the strongest, most defensible dispute grounds
 * (FCRA §607(b) requires "maximum possible accuracy").
 *
 * Every result is a LEAD: staff or the client confirms an item is actually
 * inaccurate, incomplete or unverifiable before a dispute is filed. Nothing
 * here should be used to dispute accurate information.
 */

import type { Bureau, PaymentStatus } from "@/types/credit-bureau";
import { accountLast4, creditorKey } from "./normalize";
import {
  BUREAUS,
  type BureauTradeline,
  type Discrepancy,
  type MergedTradeline,
  type PerBureau,
  type TriBureauReport,
} from "./types";

export const LEGAL = {
  accuracy: "FCRA §607(b), 15 U.S.C. §1681e(b) — maximum possible accuracy",
  reinvestigation: "FCRA §611, 15 U.S.C. §1681i — reinvestigation of disputed information",
  furnisher: "FCRA §623(a), 15 U.S.C. §1681s-2(a) — furnisher duty to report accurately",
  obsolete: "FCRA §605(a), 15 U.S.C. §1681c(a) — obsolete information",
  permissiblePurpose: "FCRA §604, 15 U.S.C. §1681b — permissible purpose for inquiries",
} as const;

const NEGATIVE: PaymentStatus[] = [
  "late_30", "late_60", "late_90", "late_120", "charge_off", "collection",
];
const STATUS_RANK: Record<PaymentStatus, number> = {
  current: 0, closed: 0, late_30: 1, late_60: 2, late_90: 3, late_120: 4,
  collection: 5, charge_off: 5,
};
const DAY = 86_400_000;

export interface AnalyzerOptions {
  /** "Today" for age calculations. Defaults to the report date, then now. */
  asOf?: Date;
}

export function analyzeCrossBureau(
  report: TriBureauReport,
  options: AnalyzerOptions = {},
): Discrepancy[] {
  const asOf = options.asOf ?? report.reportDate ?? new Date();
  const out: Discrepancy[] = [];

  for (const tl of report.tradelines) {
    out.push(...compareTradeline(tl, report.bureausPresent, asOf));
  }
  out.push(...analyzeInquiries(report, asOf));
  out.push(...analyzePersonal(report));

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* ------------------------------------------------------------------ */
/* Tradelines                                                          */
/* ------------------------------------------------------------------ */

function reporting(tl: MergedTradeline): Array<[Bureau, BureauTradeline]> {
  return BUREAUS.flatMap((b) => (tl.bureaus[b] ? [[b, tl.bureaus[b]!] as [Bureau, BureauTradeline]] : []));
}

function fmtMoney(n: number | undefined): string {
  return n === undefined ? "not reported" : `$${n.toLocaleString("en-US")}`;
}

function fmtDate(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "not reported";
}

function compareTradeline(
  tl: MergedTradeline,
  present: Bureau[],
  asOf: Date,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  const rows = reporting(tl);
  const base = { tradelineKey: tl.key, creditorName: tl.creditorName };
  const isDerog = (t: BureauTradeline) =>
    t.paymentStatus === "charge_off" || t.paymentStatus === "collection";

  // 1. Negative account not reported by every bureau that has a file.
  if (tl.isNegative) {
    const missing = present.filter((b) => !tl.bureaus[b]);
    if (missing.length > 0 && rows.length > 0) {
      out.push({
        ...base,
        type: "missing_on_bureau",
        severity: "medium",
        bureaus: rows.map(([b]) => b),
        description: `${tl.creditorName} is reported as negative by ${rows.map(([b]) => cap(b)).join(", ")} but not by ${missing.map(cap).join(", ")}. Inconsistent reporting is grounds to demand verification.`,
        legalBasis: LEGAL.reinvestigation,
      });
    }
  }

  if (rows.length < 2) {
    pushObsolete(tl, rows, asOf, out);
    return out;
  }

  // 2. Payment status disagreement.
  const statuses = rows.filter(([, t]) => t.paymentStatus);
  const distinct = new Set(statuses.map(([, t]) => STATUS_RANK[t.paymentStatus!]));
  if (distinct.size > 1) {
    const best = Math.min(...distinct);
    out.push({
      ...base,
      type: "status_mismatch",
      severity: "high",
      field: "payment_status",
      bureaus: statuses.filter(([, t]) => STATUS_RANK[t.paymentStatus!] > best).map(([b]) => b),
      values: perBureau(statuses, (t) => t.paymentStatusText ?? t.paymentStatus ?? ""),
      description: `Bureaus disagree on the payment status of ${tl.creditorName}. The more negative status can't be verified as accurate while another bureau shows it better.`,
      legalBasis: LEGAL.accuracy,
    });
  }

  // 3. Balance disagreement. Open accounts can differ by reporting cycle,
  //    so only material gaps count; derogatory accounts should match exactly.
  const balances = rows.filter(([, t]) => t.balance !== undefined);
  if (balances.length >= 2) {
    const vals = balances.map(([, t]) => t.balance!);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const derog = balances.some(([, t]) => isDerog(t));
    const material = derog ? max - min >= 1 : max - min > Math.max(50, max * 0.1);
    if (material) {
      out.push({
        ...base,
        type: "balance_mismatch",
        severity: derog ? "high" : "low",
        field: "balance",
        bureaus: balances.filter(([, t]) => t.balance! > min).map(([b]) => b),
        values: perBureau(balances, (t) => fmtMoney(t.balance)),
        description: derog
          ? `${tl.creditorName} is a charge-off/collection with different balances across bureaus (${fmtMoney(min)}–${fmtMoney(max)}). A closed derogatory balance should be identical everywhere.`
          : `${tl.creditorName} balance differs by ${fmtMoney(max - min)} across bureaus. May be reporting-cycle timing — verify before disputing.`,
        legalBasis: LEGAL.accuracy,
      });
    }
  }

  // 4. Past-due disagreement.
  const pastDue = rows.filter(([, t]) => t.pastDue !== undefined);
  if (pastDue.length >= 2) {
    const vals = pastDue.map(([, t]) => t.pastDue!);
    const min = Math.min(...vals);
    if (Math.max(...vals) - min >= 1) {
      out.push({
        ...base,
        type: "past_due_mismatch",
        severity: "high",
        field: "past_due",
        bureaus: pastDue.filter(([, t]) => t.pastDue! > min).map(([b]) => b),
        values: perBureau(pastDue, (t) => fmtMoney(t.pastDue)),
        description: `${tl.creditorName} shows different past-due amounts across bureaus.`,
        legalBasis: LEGAL.accuracy,
      });
    }
  }

  // 5. Date opened disagreement (> 31 days).
  const opened = rows.filter(([, t]) => t.openedDate);
  if (opened.length >= 2) {
    const ts = opened.map(([, t]) => t.openedDate!.getTime());
    if (Math.max(...ts) - Math.min(...ts) > 31 * DAY) {
      out.push({
        ...base,
        type: "date_opened_mismatch",
        severity: tl.isNegative ? "medium" : "low",
        field: "date_opened",
        bureaus: opened.map(([b]) => b),
        values: perBureau(opened, (t) => fmtDate(t.openedDate)),
        description: `${tl.creditorName} has different open dates across bureaus. At least one is inaccurate.`,
        legalBasis: LEGAL.accuracy,
      });
    }
  }

  // 6. Credit limit disagreement (hurts utilization).
  const limits = rows.filter(([, t]) => t.creditLimit !== undefined && t.creditLimit > 0);
  if (limits.length >= 2) {
    const vals = limits.map(([, t]) => t.creditLimit!);
    const max = Math.max(...vals);
    if (max - Math.min(...vals) >= 1) {
      out.push({
        ...base,
        type: "credit_limit_mismatch",
        severity: "low",
        field: "credit_limit",
        bureaus: limits.filter(([, t]) => t.creditLimit! < max).map(([b]) => b),
        values: perBureau(limits, (t) => fmtMoney(t.creditLimit)),
        description: `${tl.creditorName} credit limit is lower on some bureaus, which inflates reported utilization there.`,
        legalBasis: LEGAL.accuracy,
      });
    }
  }

  // 7. Month-by-month late payments one bureau reports and another doesn't.
  const lateMonths = new Map<string, Bureau[]>();
  const months = new Set(rows.flatMap(([, t]) => Object.keys(t.history)));
  for (const month of months) {
    const withData = rows.filter(([, t]) => t.history[month]);
    if (withData.length < 2) continue;
    const late = withData.filter(([, t]) => NEGATIVE.includes(t.history[month]));
    const clean = withData.filter(([, t]) => !NEGATIVE.includes(t.history[month]));
    if (late.length && clean.length) lateMonths.set(month, late.map(([b]) => b));
  }
  if (lateMonths.size > 0) {
    const flagged = [...new Set([...lateMonths.values()].flat())];
    const list = [...lateMonths.keys()].sort();
    out.push({
      ...base,
      type: "late_history_mismatch",
      severity: "high",
      field: "payment_history",
      bureaus: flagged,
      values: Object.fromEntries(
        flagged.map((b) => [b, list.filter((m) => lateMonths.get(m)!.includes(b)).join(", ")]),
      ),
      description: `${tl.creditorName}: late payment(s) in ${list.join(", ")} are reported by ${flagged.map(cap).join(", ")} but other bureaus show those months as paid on time.`,
      legalBasis: LEGAL.accuracy,
    });
  }

  // 8. Different account numbers for "the same" account → possible mixed file.
  // Only comparable when every bureau shows the same (trailing) digits.
  const numbers = rows.filter(([, t]) => accountLast4(t.accountNumber));
  const last4 = new Set(numbers.map(([, t]) => accountLast4(t.accountNumber)));
  if (last4.size > 1) {
    out.push({
      ...base,
      type: "inconsistent_account_number",
      severity: "medium",
      field: "account_number",
      bureaus: numbers.map(([b]) => b),
      values: perBureau(numbers, (t) => t.accountNumber),
      description: `${tl.creditorName} is reported under different account numbers. Confirm it's one account and not a duplicate or someone else's.`,
      legalBasis: LEGAL.accuracy,
    });
  }

  pushObsolete(tl, rows, asOf, out);
  return out;
}

/**
 * Negative items older than 7 years must come off (§605). Reports rarely
 * show the Date of First Delinquency, so we approximate with the most recent
 * of last-active / last-payment dates and flag it for staff review.
 */
function pushObsolete(
  tl: MergedTradeline,
  rows: Array<[Bureau, BureauTradeline]>,
  asOf: Date,
  out: Discrepancy[],
): void {
  if (!tl.isNegative) return;
  const sevenYears = 7 * 365.25 * DAY + 180 * DAY;
  const stale = rows.filter(([, t]) => {
    const anchor = t.lastActiveDate ?? t.lastPaymentDate;
    return anchor && asOf.getTime() - anchor.getTime() > sevenYears;
  });
  if (stale.length === 0) return;
  out.push({
    tradelineKey: tl.key,
    creditorName: tl.creditorName,
    type: "obsolete_negative",
    severity: "high",
    bureaus: stale.map(([b]) => b),
    values: perBureau(stale, (t) => fmtDate(t.lastActiveDate ?? t.lastPaymentDate)),
    description: `${tl.creditorName} appears to be past the 7-year reporting limit (last activity over 7½ years ago). Confirm the date of first delinquency, then demand deletion.`,
    legalBasis: LEGAL.obsolete,
  });
}

/* ------------------------------------------------------------------ */
/* Inquiries                                                           */
/* ------------------------------------------------------------------ */

function analyzeInquiries(report: TriBureauReport, asOf: Date): Discrepancy[] {
  const out: Discrepancy[] = [];
  const twoYears = 2 * 365.25 * DAY;

  for (const inq of report.inquiries) {
    if (inq.date && asOf.getTime() - inq.date.getTime() > twoYears) {
      out.push({
        type: "aged_inquiry",
        severity: "low",
        bureaus: [inq.bureau],
        creditorName: inq.creditorName,
        values: { [inq.bureau]: fmtDate(inq.date) },
        description: `Inquiry by ${inq.creditorName} on ${fmtDate(inq.date)} is over 2 years old and should no longer be displayed.`,
        legalBasis: LEGAL.reinvestigation,
      });
      continue;
    }

    // An inquiry with no account opened near that date: ask the client
    // whether they authorized it. Only unauthorized inquiries are disputable.
    const key = creditorKey(inq.creditorName).split(" ")[0] ?? "";
    const matched = report.tradelines.some((tl) => {
      if (!key || !tl.key.split(" ").includes(key)) return false;
      return Object.values(tl.bureaus).some(
        (t) =>
          t?.openedDate &&
          inq.date &&
          Math.abs(t.openedDate.getTime() - inq.date.getTime()) < 60 * DAY,
      );
    });
    if (!matched) {
      out.push({
        type: "unmatched_inquiry",
        severity: "low",
        bureaus: [inq.bureau],
        creditorName: inq.creditorName,
        values: { [inq.bureau]: fmtDate(inq.date) },
        description: `Inquiry by ${inq.creditorName}${inq.date ? ` on ${fmtDate(inq.date)}` : ""} has no matching new account. Confirm with the client whether they applied — dispute only if unauthorized.`,
        legalBasis: LEGAL.permissiblePurpose,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Personal information                                                */
/* ------------------------------------------------------------------ */

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function analyzePersonal(report: TriBureauReport): Discrepancy[] {
  const out: Discrepancy[] = [];
  const present = BUREAUS.filter((b) => report.personal[b]);
  if (present.length < 2) return out;

  const variants = (
    pick: (b: Bureau) => string[],
  ): { all: Set<string>; extra: PerBureau<string[]> } => {
    const counts = new Map<string, number>();
    const byBureau = new Map<Bureau, string[]>();
    for (const b of present) {
      const items = [...new Set(pick(b).map((x) => x.trim()).filter(Boolean))];
      byBureau.set(b, items);
      for (const i of new Set(items.map(norm))) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    const extra: PerBureau<string[]> = {};
    for (const [b, items] of byBureau) {
      const odd = items.filter((i) => (counts.get(norm(i)) ?? 0) < present.length);
      if (odd.length) extra[b] = odd;
    }
    return { all: new Set(counts.keys()), extra };
  };

  const names = variants((b) => [
    ...(report.personal[b]?.names ?? []),
    ...(report.personal[b]?.akas ?? []),
  ]);
  if (Object.keys(names.extra).length > 0) {
    out.push({
      type: "name_variation",
      severity: names.all.size > 3 ? "medium" : "low",
      bureaus: Object.keys(names.extra) as Bureau[],
      field: "name",
      values: mapValues(names.extra, (v) => v.join("; ")),
      description: "Name variations appear on some bureaus only. Remove any the client doesn't use — stray names can link someone else's accounts to this file.",
      legalBasis: LEGAL.accuracy,
    });
  }

  const addrs = variants((b) => [
    ...(report.personal[b]?.currentAddresses ?? []),
    ...(report.personal[b]?.previousAddresses ?? []),
  ]);
  if (Object.keys(addrs.extra).length > 0) {
    out.push({
      type: "address_variation",
      severity: "low",
      bureaus: Object.keys(addrs.extra) as Bureau[],
      field: "address",
      values: mapValues(addrs.extra, (v) => v.join("; ")),
      description: "Some addresses appear on only some bureaus. Confirm each with the client and dispute any they never lived at.",
      legalBasis: LEGAL.accuracy,
    });
  }

  const dobs = present
    .map((b) => [b, report.personal[b]?.dateOfBirth] as const)
    .filter(([, d]) => d);
  if (new Set(dobs.map(([, d]) => norm(d!))).size > 1) {
    out.push({
      type: "dob_mismatch",
      severity: "medium",
      bureaus: dobs.map(([b]) => b),
      field: "date_of_birth",
      values: Object.fromEntries(dobs),
      description: "Bureaus report different dates of birth — a common sign of a mixed file.",
      legalBasis: LEGAL.accuracy,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */

function perBureau<T>(
  rows: Array<[Bureau, T]>,
  fn: (t: T) => string,
): PerBureau<string> {
  return Object.fromEntries(rows.map(([b, t]) => [b, fn(t)]));
}

function mapValues<T, U>(o: PerBureau<T>, fn: (v: T) => U): PerBureau<U> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, fn(v as T)]),
  ) as PerBureau<U>;
}

function cap(b: string): string {
  return b === "transunion" ? "TransUnion" : b.charAt(0).toUpperCase() + b.slice(1);
}
