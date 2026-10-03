/**
 * Turns analyzer leads + client confirmations into DisputeItems.
 *
 * A lead is never disputed on its own: the client confirms it (or states a
 * fact the report can't show, like "never late" or "not my account"). That
 * keeps every letter limited to information the consumer actually contends
 * is inaccurate, incomplete or unverifiable.
 */

import type { Bureau } from "@/types/credit-bureau";
import type { Discrepancy, TriBureauReport } from "@/lib/credit-report-import/types";
import type { DisputeItem, DisputeReason, ItemKind } from "./types";

/** Stable id for a lead, so the UI can send back which ones were confirmed. */
export function leadId(d: Discrepancy): string {
  const subject = d.tradelineKey ?? d.creditorName ?? d.field ?? "personal";
  return `${d.type}:${subject}:${[...d.bureaus].sort().join("+")}`;
}

/** A fact the client states that the report itself can't show. */
export interface ClientClaim {
  kind: ItemKind;
  bureaus: Bureau[];
  /** Tradeline key for accounts; creditor name for inquiries; the exact text for personal items. */
  subject: string;
  reason: Exclude<DisputeReason, Discrepancy["type"]>;
  correctValue?: string;
}

const PERSONAL_TYPES = new Set(["name_variation", "address_variation", "dob_mismatch"]);
const INQUIRY_TYPES = new Set(["aged_inquiry", "unmatched_inquiry"]);

export function buildDisputeItems(
  report: TriBureauReport,
  leads: Discrepancy[],
  confirmedLeadIds: Iterable<string>,
  claims: ClientClaim[] = [],
): DisputeItem[] {
  const confirmed = new Set(confirmedLeadIds);
  const items = new Map<string, DisputeItem>();

  const upsert = (
    kind: ItemKind,
    bureau: Bureau,
    name: string,
    key: string | undefined,
    reason: DisputeReason,
    extra: Partial<DisputeItem> = {},
  ) => {
    const id = `${kind}:${key ?? name}:${bureau}`;
    const { evidence, ...rest } = extra;
    const existing = items.get(id);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      Object.assign(existing, Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      ));
      if (evidence) Object.assign(existing.evidence, evidence);
      return;
    }
    const tl = key ? report.tradelines.find((t) => t.key === key) : undefined;
    const bt = tl?.bureaus[bureau];
    items.set(id, {
      id,
      kind,
      bureau,
      name,
      tradelineKey: key,
      accountNumber: bt?.accountNumber || undefined,
      isCollection:
        bt?.paymentStatus === "collection" ||
        /collection/i.test(bt?.accountTypeText ?? "") ||
        undefined,
      reasons: [reason],
      evidence: {},
      confirmedByClient: true,
      outcomes: [],
      ...rest,
    });
    if (evidence) Object.assign(items.get(id)!.evidence, evidence);
  };

  for (const d of leads) {
    if (!confirmed.has(leadId(d))) continue;
    const kind: ItemKind = PERSONAL_TYPES.has(d.type)
      ? "personal"
      : INQUIRY_TYPES.has(d.type)
        ? "inquiry"
        : "account";

    // A DOB conflict is only an error on the bureau(s) reporting the odd one out.
    let bureaus = d.bureaus;
    if (d.type === "dob_mismatch" && d.values) {
      const counts = new Map<string, number>();
      for (const v of Object.values(d.values)) counts.set(v!, (counts.get(v!) ?? 0) + 1);
      const top = Math.max(...counts.values());
      bureaus = d.bureaus.filter((b) => (counts.get(d.values?.[b] ?? "") ?? 0) < top);
    }

    for (const b of bureaus) {
      const reported = d.values?.[b];
      const others = Object.fromEntries(
        Object.entries(d.values ?? {}).filter(([k]) => k !== b),
      ) as Partial<Record<Bureau, string>>;
      if (kind === "personal") {
        // One item per stray value so each can be deleted on its own.
        for (const value of (reported ?? "").split("; ").filter(Boolean)) {
          upsert("personal", b, value, `${d.field}:${value}`, d.type, {
            evidence: { [d.type]: { reported: value } },
          });
        }
        continue;
      }
      const tl = d.tradelineKey ? report.tradelines.find((t) => t.key === d.tradelineKey) : undefined;
      const missingFrom =
        d.type === "missing_on_bureau" && tl
          ? report.bureausPresent.filter((x) => !tl.bureaus[x])
          : undefined;
      upsert(kind, b, d.creditorName ?? "Unknown", kind === "account" ? d.tradelineKey : d.creditorName, d.type, {
        evidence: {
          [d.type]: {
            reported,
            others: Object.keys(others).length ? others : undefined,
            missingFrom,
          },
        },
      });
    }
  }

  for (const c of claims) {
    for (const b of c.bureaus) {
      const tl = c.kind === "account" ? report.tradelines.find((t) => t.key === c.subject) : undefined;
      upsert(c.kind, b, tl?.creditorName ?? c.subject, c.subject, c.reason, {
        correctValue: c.correctValue,
      });
    }
  }

  return [...items.values()];
}
