/**
 * Dispute engine types — Rounds 1, 2, 3 for bureaus, furnishers and collectors.
 *
 * Flow: TriBureauReport + Discrepancy leads → client confirms which items are
 * actually inaccurate → DisputeItems → a RoundPlan (letters per recipient) →
 * outcomes recorded per item → next round planned from what remains.
 */

import type { Bureau } from "@/types/credit-bureau";
import type { DiscrepancyType } from "@/lib/credit-report-import/types";

export type Round = 1 | 2 | 3;

export type ItemKind = "account" | "inquiry" | "personal" | "public_record";

/**
 * Why an item is disputed. Cross-bureau discrepancy types come from the
 * analyzer; the rest can only come from the client (they know facts the
 * report can't show).
 */
export type DisputeReason =
  | DiscrepancyType
  | "not_mine"
  | "identity_theft"
  | "never_late"
  | "paid_in_full"
  | "unauthorized_inquiry"
  | "never_lived_at_address"
  | "never_used_name";

export type Outcome =
  | "pending"
  | "deleted"
  | "updated"
  | "verified"
  | "no_response";

export interface Metro2Ref {
  field: string; // e.g. "21"
  name: string; // e.g. "Current Balance"
}

export interface Evidence {
  reported?: string;
  others?: Partial<Record<Bureau, string>>;
  missingFrom?: Bureau[];
}

export interface DisputeItem {
  id: string;
  kind: ItemKind;
  bureau: Bureau;
  /** Creditor / collector / inquirer; for personal items, the label. */
  name: string;
  /** Masked, as on the report. */
  accountNumber?: string;
  tradelineKey?: string;
  reasons: DisputeReason[];
  /** Evidence per reason: this bureau's value, other bureaus' values, bureaus missing it. */
  evidence: Partial<Record<DisputeReason, Evidence>>;
  /** The correct value, when the client supplied one. */
  correctValue?: string;
  /** Item is a collection account held by a third-party collector / debt buyer. */
  isCollection?: boolean;
  /** Original creditor, when a debt buyer reports it. */
  originalCreditor?: string;
  /**
   * The client confirmed in writing this item is inaccurate, incomplete or
   * unauthorized. Only confirmed items are ever put in a letter.
   */
  confirmedByClient: boolean;
  /** Outcome history, index 0 = Round 1. */
  outcomes: Outcome[];
  /** Date of the bureau's response that produced the latest outcome (MM/DD/YYYY). */
  lastResponseDate?: string;
}

export interface Consumer {
  fullName: string;
  /** Lines of the current mailing address. */
  addressLines: string[];
  /** Two-letter state of residence (drives state-law add-ons). */
  state: string;
}

export interface Recipient {
  kind: "bureau" | "furnisher" | "collector";
  name: string;
  addressLines: string[];
  bureau?: Bureau;
}

export interface Letter {
  round: Round;
  recipient: Recipient;
  itemIds: string[];
  subject: string;
  /** Plain text, block paragraphs separated by one blank line. */
  body: string;
  enclosures: string;
  /** Statutes this letter relies on, for the file's audit trail. */
  legalBasis: string[];
}

export interface RoundPlan {
  round: Round;
  letters: Letter[];
  /** Items left out of this round, with why. */
  skipped: Array<{ itemId: string; reason: string }>;
}

export interface RoundTimeline {
  round: Round;
  mailedOn: string; // ISO date
  /** §1681i(a)(1)(A): 30 days from receipt; we count from delivery. */
  responseDueOn: string;
  /** If the consumer sends more info during the window, +15 days. */
  extendedDueOn: string;
  /** Firm standard: next round goes out at day 45 if items remain. */
  nextRoundEligibleOn: string;
}
