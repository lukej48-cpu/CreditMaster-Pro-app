/**
 * Types for 3-bureau consumer report imports (IdentityIQ, MyScoreIQ,
 * SmartCredit and compatible "TransUnion | Experian | Equifax" layouts).
 */

import type {
  AccountType,
  Bureau,
  PaymentStatus,
  PublicRecordType,
} from "@/types/credit-bureau";

export const BUREAUS: readonly Bureau[] = ["transunion", "experian", "equifax"];

export type ReportSource =
  | "identityiq"
  | "myscoreiq"
  | "smartcredit"
  | "generic_3b_html";

/** One value as each bureau reports it. Missing key = bureau did not report. */
export type PerBureau<T> = Partial<Record<Bureau, T>>;

/** A single bureau's view of a tradeline. */
export interface BureauTradeline {
  accountNumber: string; // masked
  accountType: AccountType;
  accountTypeText?: string;
  accountStatusText?: string;
  paymentStatusText?: string;
  paymentStatus?: PaymentStatus;
  balance?: number;
  creditLimit?: number;
  highCredit?: number;
  pastDue?: number;
  monthlyPayment?: number;
  openedDate?: Date;
  closedDate?: Date;
  lastReportedDate?: Date;
  lastActiveDate?: Date;
  lastPaymentDate?: Date;
  termMonths?: number;
  responsibility?: string;
  comments?: string;
  /** "YYYY-MM" -> status, from the 2-year payment history grid. */
  history: Record<string, PaymentStatus>;
}

/**
 * One account merged across bureaus. The dispute engine works off this:
 * every difference between `bureaus.*` values is a potential inaccuracy.
 */
export interface MergedTradeline {
  key: string;
  creditorName: string;
  bureaus: PerBureau<BureauTradeline>;
  /** True if any bureau reports it as negative (late, CO, collection). */
  isNegative: boolean;
}

export interface ImportedInquiry {
  creditorName: string;
  date?: Date;
  bureau: Bureau;
  typeOfBusiness?: string;
}

export interface ImportedPublicRecord {
  recordType: PublicRecordType;
  bureau: Bureau;
  filingDate?: Date;
  status: string;
  amount?: number;
  courtName?: string;
  caseNumber?: string;
}

export interface BureauPersonalInfo {
  names: string[];
  akas: string[];
  dateOfBirth?: string;
  currentAddresses: string[];
  previousAddresses: string[];
  employers: string[];
}

export interface TriBureauReport {
  source: ReportSource;
  reportDate?: Date;
  scores: PerBureau<number>;
  scoreModel?: string;
  personal: PerBureau<BureauPersonalInfo>;
  tradelines: MergedTradeline[];
  inquiries: ImportedInquiry[];
  publicRecords: ImportedPublicRecord[];
  /** Bureaus that actually had data in the file. */
  bureausPresent: Bureau[];
  /** Non-fatal problems: unrecognized rows, unparseable values, etc. */
  warnings: string[];
}

export type DiscrepancySeverity = "high" | "medium" | "low";

export type DiscrepancyType =
  | "missing_on_bureau"
  | "balance_mismatch"
  | "status_mismatch"
  | "past_due_mismatch"
  | "date_opened_mismatch"
  | "credit_limit_mismatch"
  | "late_history_mismatch"
  | "obsolete_negative"
  | "aged_inquiry"
  | "unmatched_inquiry"
  | "name_variation"
  | "address_variation"
  | "dob_mismatch"
  | "inconsistent_account_number";

/**
 * A disputable inconsistency found by comparing bureaus. These are leads,
 * not conclusions — a staff member or the client confirms each one is
 * actually inaccurate before a dispute is filed.
 */
export interface Discrepancy {
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  /** Bureaus whose reporting should be disputed. */
  bureaus: Bureau[];
  tradelineKey?: string;
  creditorName?: string;
  field?: string;
  values?: PerBureau<string>;
  description: string;
  /** Statute the dispute would rely on. */
  legalBasis: string;
}
