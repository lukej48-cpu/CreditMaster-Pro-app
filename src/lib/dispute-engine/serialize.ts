/**
 * JSON round-trip for TriBureauReport (stored in JSONB): Date fields become
 * ISO strings on the way in and Dates again on the way out.
 */

import type { TriBureauReport } from "@/lib/credit-report-import/types";

const DATE_KEYS = new Set([
  "reportDate",
  "openedDate",
  "closedDate",
  "lastReportedDate",
  "lastActiveDate",
  "lastPaymentDate",
  "date",
  "filingDate",
]);

export function reportToJson(report: TriBureauReport): unknown {
  return JSON.parse(JSON.stringify(report));
}

export function reportFromJson(json: unknown): TriBureauReport {
  return JSON.parse(JSON.stringify(json), (key, value) =>
    DATE_KEYS.has(key) && typeof value === "string" ? new Date(value) : value,
  ) as TriBureauReport;
}
