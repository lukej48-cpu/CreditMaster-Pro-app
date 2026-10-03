/**
 * Maps a TriBureauReport onto the existing per-bureau tables
 * (credit_reports, credit_accounts, credit_inquiries, public_records).
 *
 * Pure functions only — the API route does the actual inserts. Keeping the
 * mapping here makes it unit-testable without a database.
 */

import type { Bureau } from "@/types/credit-bureau";
import { toIsoDate } from "./normalize";
import {
  BUREAUS,
  type Discrepancy,
  type TriBureauReport,
} from "./types";

export interface ImportMeta {
  userId: string;
  importId: string;
  fileName: string;
  fileSha256: string;
  /** Used when the report itself has no readable date. */
  today: Date;
}

export interface BureauSlice {
  bureau: Bureau;
  report: Record<string, unknown>;
  accounts: Array<Record<string, unknown>>;
  inquiries: Array<Record<string, unknown>>;
  publicRecords: Array<Record<string, unknown>>;
}

/** DB check constraint is 300–850; other score scales are stored as null. */
function dbScore(score: number | undefined): number | null {
  return score !== undefined && score >= 300 && score <= 850 ? score : null;
}

export function toBureauSlices(
  report: TriBureauReport,
  discrepancies: Discrepancy[],
  meta: ImportMeta,
): BureauSlice[] {
  const reportDate = toIsoDate(report.reportDate ?? meta.today)!;

  return BUREAUS.filter((b) => report.bureausPresent.includes(b)).map((bureau) => {
    const tradelines = report.tradelines.flatMap((tl) => {
      const t = tl.bureaus[bureau];
      return t ? [{ creditorName: tl.creditorName, key: tl.key, ...t }] : [];
    });
    const inquiries = report.inquiries.filter((i) => i.bureau === bureau);
    const records = report.publicRecords.filter((r) => r.bureau === bureau);
    const score = report.scores[bureau];

    const parsedData = {
      importId: meta.importId,
      source: report.source,
      scoreModel: report.scoreModel ?? null,
      rawScore: score ?? null,
      personal: report.personal[bureau] ?? null,
      tradelines: tradelines.map((t) => ({
        ...t,
        openedDate: toIsoDate(t.openedDate),
        closedDate: toIsoDate(t.closedDate),
        lastReportedDate: toIsoDate(t.lastReportedDate),
        lastActiveDate: toIsoDate(t.lastActiveDate),
        lastPaymentDate: toIsoDate(t.lastPaymentDate),
      })),
      discrepancies: discrepancies.filter((d) => d.bureaus.includes(bureau)),
      warnings: report.warnings,
    };

    return {
      bureau,
      report: {
        user_id: meta.userId,
        bureau,
        report_date: reportDate,
        credit_score: dbScore(score),
        score: dbScore(score),
        score_factors: [],
        // Never the uploaded HTML itself: it carries PII. Hash only, for
        // de-duplication and audit.
        raw_data: {
          import_id: meta.importId,
          source: report.source,
          file_name: meta.fileName,
          file_sha256: meta.fileSha256,
          imported_via: "3b_html_upload",
        },
        parsed_data: parsedData,
      },
      accounts: tradelines.map((t) => ({
        user_id: meta.userId,
        account_type: t.accountType,
        account_number: t.accountNumber || null,
        creditor_name: t.creditorName,
        balance: t.balance ?? null,
        credit_limit: t.creditLimit ?? null,
        payment_status: t.paymentStatus ?? null,
        opened_date: toIsoDate(t.openedDate),
        closed_date: toIsoDate(t.closedDate),
        last_payment_date: toIsoDate(t.lastPaymentDate),
        payment_history: Object.entries(t.history)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, status]) => ({ month, status })),
        is_disputed: false,
      })),
      // credit_inquiries.inquiry_date is NOT NULL — undated rows are kept in
      // parsed_data only.
      inquiries: inquiries
        .filter((i) => i.date)
        .map((i) => ({
          user_id: meta.userId,
          inquiry_type: "hard",
          creditor_name: i.creditorName,
          inquiry_date: toIsoDate(i.date),
          is_disputed: false,
        })),
      publicRecords: records.map((r) => ({
        user_id: meta.userId,
        record_type: r.recordType,
        filing_date: toIsoDate(r.filingDate),
        status: r.status,
        amount: r.amount ?? null,
        court_name: r.courtName ?? null,
        case_number: r.caseNumber ?? null,
        is_disputed: false,
      })),
    };
  });
}

export interface ImportSummary {
  source: TriBureauReport["source"];
  reportDate: string | null;
  bureaus: Bureau[];
  scores: TriBureauReport["scores"];
  accounts: number;
  negativeAccounts: number;
  inquiries: number;
  publicRecords: number;
  discrepancies: { total: number; high: number; medium: number; low: number };
  warnings: string[];
}

export function summarizeImport(
  report: TriBureauReport,
  discrepancies: Discrepancy[],
): ImportSummary {
  const count = (s: Discrepancy["severity"]) =>
    discrepancies.filter((d) => d.severity === s).length;
  return {
    source: report.source,
    reportDate: toIsoDate(report.reportDate),
    bureaus: report.bureausPresent,
    scores: report.scores,
    accounts: report.tradelines.length,
    negativeAccounts: report.tradelines.filter((t) => t.isNegative).length,
    inquiries: report.inquiries.length,
    publicRecords: report.publicRecords.length,
    discrepancies: {
      total: discrepancies.length,
      high: count("high"),
      medium: count("medium"),
      low: count("low"),
    },
    warnings: report.warnings.slice(0, 20),
  };
}
