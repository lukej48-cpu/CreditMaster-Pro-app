/**
 * Metro 2® Base Segment field references (CDIA Credit Reporting Resource
 * Guide) for each dispute reason. Letters cite the exact field a furnisher
 * reported wrong, which is what a bureau analyst and the furnisher's e-OSCAR
 * ACDV response actually work with.
 *
 * Note: the e-OSCAR dispute code on the ACDV is chosen by the bureau, not the
 * consumer. Naming the precise Metro 2 field and value pushes the bureau to
 * code the dispute correctly instead of a generic "consumer disputes".
 */

import type { DisputeReason, Metro2Ref } from "./types";

export const METRO2 = {
  accountNumber: { field: "7", name: "Consumer Account Number" },
  dateOpened: { field: "10", name: "Date Opened" },
  creditLimit: { field: "11", name: "Credit Limit" },
  highCredit: { field: "12", name: "Highest Credit or Original Loan Amount" },
  accountStatus: { field: "17A", name: "Account Status" },
  paymentRating: { field: "17B", name: "Payment Rating" },
  paymentHistory: { field: "18", name: "Payment History Profile" },
  specialComment: { field: "19", name: "Special Comment" },
  complianceCondition: { field: "20", name: "Compliance Condition Code" },
  currentBalance: { field: "21", name: "Current Balance" },
  amountPastDue: { field: "22", name: "Amount Past Due" },
  chargeOffAmount: { field: "23", name: "Original Charge-off Amount" },
  dateOfAccountInfo: { field: "24", name: "Date of Account Information" },
  dofd: { field: "25", name: "FCRA Compliance/Date of First Delinquency" },
  dateClosed: { field: "26", name: "Date Closed" },
  lastPayment: { field: "27", name: "Date of Last Payment" },
  ecoa: { field: "37", name: "ECOA Code" },
} satisfies Record<string, Metro2Ref>;

const BY_REASON: Partial<Record<DisputeReason, Metro2Ref[]>> = {
  balance_mismatch: [METRO2.currentBalance],
  status_mismatch: [METRO2.accountStatus, METRO2.paymentRating],
  past_due_mismatch: [METRO2.amountPastDue],
  date_opened_mismatch: [METRO2.dateOpened],
  credit_limit_mismatch: [METRO2.creditLimit, METRO2.highCredit],
  late_history_mismatch: [METRO2.paymentHistory],
  never_late: [METRO2.paymentHistory, METRO2.paymentRating],
  obsolete_negative: [METRO2.dofd],
  inconsistent_account_number: [METRO2.accountNumber],
  missing_on_bureau: [METRO2.accountStatus],
  paid_in_full: [METRO2.currentBalance, METRO2.accountStatus],
  not_mine: [METRO2.ecoa],
  identity_theft: [METRO2.ecoa],
};

export function metro2For(reasons: DisputeReason[]): Metro2Ref[] {
  const seen = new Map<string, Metro2Ref>();
  for (const r of reasons) {
    for (const ref of BY_REASON[r] ?? []) seen.set(ref.field, ref);
  }
  return [...seen.values()];
}

/** "Field 21 (Current Balance)" — the form letters use. */
export function describeField(ref: Metro2Ref): string {
  return `Metro 2 Field ${ref.field} (${ref.name})`;
}
