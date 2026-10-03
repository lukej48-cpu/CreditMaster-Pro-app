/**
 * Letter composer — FUNDED UP letter standard.
 *
 * Every letter is in the consumer's own first-person voice, block format, no
 * bullets, no bold outline headers, an "Acct:" lead-in per disputed account,
 * multi-item demands as inline numbered clauses, no mid-sentence em-dashes,
 * and a different opening/closing skeleton for each letter in a packet.
 *
 * Round 1: account-level legal leverage (§1681i + Cushman; §1681s-2 direct
 * furnisher dispute; FDCPA §1692g validation for collectors).
 * Round 2+: the bureau's own prior response is the target (CFPB Circular
 * 2022-07 + Cushman, method-of-verification demand, §1681i(a)(5)(A)).
 */

import type { Bureau } from "@/types/credit-bureau";
import { describeField, metro2For } from "./metro2";
import type { Consumer, DisputeItem, DisputeReason, Letter, Recipient, Round } from "./types";

export const BUREAU_ADDRESSES: Record<Bureau, Recipient> = {
  experian: {
    kind: "bureau",
    bureau: "experian",
    name: "Experian",
    addressLines: ["P.O. Box 4500", "Allen, TX 75013"],
  },
  equifax: {
    kind: "bureau",
    bureau: "equifax",
    name: "Equifax Information Services LLC",
    addressLines: ["P.O. Box 740256", "Atlanta, GA 30374"],
  },
  transunion: {
    kind: "bureau",
    bureau: "transunion",
    name: "TransUnion Consumer Solutions",
    addressLines: ["P.O. Box 2000", "Chester, PA 19016"],
  },
};

export const ENCLOSURES_DEFAULT =
  "Enclosures: Copy of government-issued photo ID (front and back); proof of Social Security Number; proof of current address. Provided for identity verification purposes only.";

const BUREAU_NAME: Record<Bureau, string> = {
  transunion: "TransUnion",
  experian: "Experian",
  equifax: "Equifax",
};

export function formatDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

/** "A, B and C" */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "(1) x; (2) y; and (3) z" */
export function numbered(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return parts
    .map((p, i) => `(${i + 1}) ${p}`)
    .map((p, i, arr) => (i === arr.length - 1 ? `and ${p}` : p))
    .join("; ");
}

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Letter-style values: ISO dates → MM/DD/YYYY, "2026-03" → "March 2026". */
export function fmtVal(v: string | undefined): string | undefined {
  if (!v) return v;
  return v
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$2/$3/$1")
    .replace(/\b(\d{4})-(\d{2})\b/g, (_, y: string, m: string) => `${MONTH[Number(m) - 1]} ${y}`);
}

function others(map: Partial<Record<Bureau, string>> | undefined): string | undefined {
  const entries = Object.entries(map ?? {}) as Array<[Bureau, string]>;
  if (!entries.length) return undefined;
  // Group bureaus that report the same value.
  const byValue = new Map<string, Bureau[]>();
  for (const [b, v] of entries) byValue.set(v, [...(byValue.get(v) ?? []), b]);
  return joinAnd(
    [...byValue.entries()].map(([v, bs]) => `${joinAnd(bs.map((b) => BUREAU_NAME[b]))} ${bs.length > 1 ? "report" : "reports"} ${fmtVal(v)}`),
  );
}

/* ------------------------------------------------------------------ */
/* Item paragraphs                                                      */
/* ------------------------------------------------------------------ */

const CONFLICT_LABEL: Partial<Record<DisputeReason, string>> = {
  balance_mismatch: "balance",
  status_mismatch: "payment status",
  past_due_mismatch: "past-due amount",
  date_opened_mismatch: "open date",
  credit_limit_mismatch: "credit limit",
  inconsistent_account_number: "account number",
};

/** For a furnisher: "$842 to TransUnion and $910 to Equifax". */
function furnisherConflict(item: DisputeItem, reason: DisputeReason): string | undefined {
  const ev = item.evidence?.[reason];
  const label = CONFLICT_LABEL[reason];
  if (!ev || !label) return undefined;
  const all = { ...(ev.others ?? {}), ...(ev.reported ? { [item.bureau]: ev.reported } : {}) } as Partial<Record<Bureau, string>>;
  const parts = (Object.entries(all) as Array<[Bureau, string]>).map(([b, v]) => `${fmtVal(v)} to ${BUREAU_NAME[b]}`);
  if (parts.length < 2) return undefined;
  return `You report the ${label} of this account as ${joinAnd(parts)}. The same account cannot have more than one correct ${label}, so your own reporting shows it is inaccurate.`;
}

function reasonSentence(
  item: DisputeItem,
  reason: DisputeReason,
  round: Round,
  audience: Recipient["kind"] = "bureau",
): string | undefined {
  if (audience !== "bureau") {
    const f = furnisherConflict(item, reason);
    if (f) return f;
    if (reason === "late_history_mismatch") {
      const ev = item.evidence?.[reason] ?? {};
      const map = { ...(ev.others ?? {}), ...(ev.reported ? { [item.bureau]: ev.reported } : {}) } as Partial<Record<Bureau, string>>;
      const parts = (Object.entries(map) as Array<[Bureau, string]>).map(([b, v]) => `${fmtVal(v)} to ${BUREAU_NAME[b]}`);
      return `You report a late payment in ${joinAnd(parts)}, while your reporting to the other bureaus shows ${parts.length > 1 || /,| and /.test(parts[0] ?? "") ? "those months" : "that month"} paid on time.`;
    }
  }
  const ev = item.evidence?.[reason] ?? {};
  const raw = ev.reported ?? Object.values(ev.others ?? {})[0];
  const r = fmtVal(raw);
  const differing = Object.fromEntries(
    Object.entries(ev.others ?? {}).filter(([, v]) => v !== ev.reported),
  ) as Partial<Record<Bureau, string>>;
  const o = others(differing) ?? "the other bureaus report it differently";
  switch (reason) {
    case "balance_mismatch":
      return `You report the balance as ${r}, while ${o}. One account cannot carry two different balances, so the figure in my file has not been verified as accurate.`;
    case "status_mismatch":
      return `You list the payment status as ${r}, but ${o}. The more negative status cannot be accurate while another bureau shows this account better.`;
    case "past_due_mismatch":
      return `The past-due amount you show is ${r}, yet ${o}.`;
    case "date_opened_mismatch":
      return `You show this account as opened ${r}, while ${o}. At least one of these dates is wrong, and the date controls how this account ages in my file.`;
    case "credit_limit_mismatch":
      return `You report a credit limit of ${r}, but ${o}. The lower figure overstates my utilization.`;
    case "late_history_mismatch":
      return `You report a late payment in ${r}. The other bureaus show ${/,| and /.test(r ?? "") ? "those months" : "that month"} as paid on time, which matches my records.`;
    case "never_late":
      return `I was never late on this account, and the late payments in my history are inaccurate.`;
    case "obsolete_negative":
      return `The last activity on this account was ${r}. Based on the dates in my file it is past the reporting period allowed by 15 U.S.C. §1681c(a), measured from the Date of First Delinquency.`;
    case "missing_on_bureau": {
      const miss = ev.missingFrom ?? [];
      if (!miss.length) return undefined;
      return `This negative account does not appear on my ${joinAnd(miss.map((b) => BUREAU_NAME[b]))} report${miss.length > 1 ? "s" : ""}, which raises real doubt that it is being reported to you accurately.`;
    }
    case "inconsistent_account_number":
      return `The account number you show, ${r}, does not match the number other bureaus report for the same account (${o}). I need to know this is one account and not a duplicate or someone else's record.`;
    case "paid_in_full":
      return `This account was paid in full and should report a zero balance${item.correctValue ? ` with a status of ${item.correctValue}` : ""}.`;
    case "not_mine":
      return `This account is not mine. I never opened it and never authorized anyone to open it in my name.`;
    case "identity_theft":
      return `This account was opened through identity theft. I did not open it, use it or benefit from it.`;
    case "aged_inquiry":
      return `The inquiry dated ${r} is more than two years old and should no longer appear in my file.`;
    case "unmatched_inquiry":
    case "unauthorized_inquiry":
      return `I did not authorize the inquiry${r ? ` dated ${r}` : ""} and did not apply for credit with this company. Please show the permissible purpose required by 15 U.S.C. §1681b.`;
    case "name_variation":
    case "never_used_name":
      return round === 1
        ? `My file lists the name "${item.name}". I have never used that name.`
        : `My file still lists the name "${item.name}". I have never used that name.`;
    case "address_variation":
    case "never_lived_at_address":
      return `My file lists the address "${item.name}". I have never lived at that address.`;
    case "dob_mismatch":
      return `My file shows a date of birth that does not match my records or my enclosed identification.`;
    default:
      return undefined;
  }
}

function itemParagraph(item: DisputeItem, round: Round, audience: Recipient["kind"]): string {
  const sentences = item.reasons
    .map((r) => reasonSentence(item, r, round, audience))
    .filter((s): s is string => Boolean(s));
  const fields = metro2For(item.reasons);
  if (fields.length && item.kind === "account") {
    sentences.push(
      `The data at issue is ${joinAnd(fields.map(describeField))}.`,
    );
  }

  if (item.kind === "personal") {
    const lead = "On personal information: ";
    sentences.push(
      "This is a confirmed error, not a disputed claim. No furnisher record could ever verify it, so it must be deleted under 15 U.S.C. §1681i(a)(5)(A).",
    );
    return lead + sentences.join(" ");
  }

  const prior = item.outcomes[item.outcomes.length - 1];
  if (round > 1 && prior && audience === "bureau") {
    sentences.unshift(
      prior === "no_response"
        ? "You did not respond to my earlier dispute of this item within the time the law allows."
        : `After my earlier dispute you marked this item ${prior === "updated" ? "updated" : "verified"}, but the problem I described is still there.`,
    );
  }

  const label =
    item.kind === "inquiry"
      ? `Inquiry: ${item.name}.`
      : `Acct: ${item.name}${item.accountNumber ? `, account ${item.accountNumber}` : ""}.`;
  const remedy =
    item.kind === "inquiry"
      ? item.reasons.some((x) => x === "unmatched_inquiry" || x === "unauthorized_inquiry")
        ? "If you cannot, delete this inquiry."
        : "Please delete this inquiry."
      : item.correctValue
        ? `Please correct it to ${item.correctValue}, or delete the account if the information cannot be verified.`
        : "Please delete this account, or correct every inaccurate field if it can be fully verified.";
  return `${label} ${sentences.join(" ")} ${remedy}`;
}

/* ------------------------------------------------------------------ */
/* Openings and closings (varied per letter)                           */
/* ------------------------------------------------------------------ */

const BUREAU_OPEN_R1 = [
  (b: string) => `I am disputing the accuracy of the items below in my ${b} credit file under 15 U.S.C. §1681i.`,
  (b: string) => `After reviewing my ${b} report, I found information that is inaccurate, and I am asking you to reinvestigate it under 15 U.S.C. §1681i.`,
  (b: string) => `Please treat this letter as my formal dispute of the following items in the credit file ${b} keeps on me, under 15 U.S.C. §1681i.`,
];

const BUREAU_OPEN_R2 = [
  (b: string, d?: string) => `I received your reinvestigation results${d ? ` dated ${d}` : ""}. You did not correct the problems I wrote about, and certifying an item is not the same as verifying it.`,
  (b: string, d?: string) => `This follows my earlier dispute with ${b}${d ? ` and your response dated ${d}` : ""}. The items below remain inaccurate, and a furnisher's confirmation does not resolve the contradictions I raised.`,
  (b: string, d?: string) => `Your response to my prior dispute${d ? `, dated ${d},` : ""} left the errors below in place. Repeating what the furnisher already reported is not a reasonable reinvestigation.`,
];

const BUREAU_OPEN_R3 = [
  (b: string) => `This is my third written dispute with ${b} about the same items. Two reinvestigations have not fixed them.`,
  (b: string) => `I have now disputed these items with ${b} twice, and each time they came back unchanged. I am writing one last time before I take further action.`,
  (b: string) => `Despite two prior disputes, ${b} continues to report the information below. This letter is my final request before I escalate.`,
];

function bureauLegalParagraph(round: Round): string {
  if (round === 1) {
    return "A reasonable reinvestigation requires actual review of the underlying documents, not an automated re-check of the same data. See Cushman v. Trans Union Corp., 115 F.3d 220 (3d Cir. 1997).";
  }
  return "Under CFPB Consumer Financial Protection Circular 2022-07, a bare \"verified\" response from a furnisher does not satisfy your duty to conduct a reasonable reinvestigation; you must review the evidence and the specific contradictions I raised. The same principle was set out in Cushman v. Trans Union Corp., 115 F.3d 220 (3d Cir. 1997).";
}

function movParagraph(): string {
  return `For any item you do not delete, I request a description of the procedure used to determine its accuracy under 15 U.S.C. §1681i(a)(6)(B)(iii) and §1681i(a)(7), including ${numbered([
    "the name, address and telephone number of each furnisher you contacted",
    "the specific documents you reviewed",
    "the date of that review",
  ])}. Restating the account information already on my report is not a method of verification.`;
}

const BUREAU_CLOSE = [
  "Please complete your reinvestigation within 30 days as required by 15 U.S.C. §1681i(a)(1)(A) and send me an updated copy of my report. If these items are verified without addressing the specific problems I described, I will file complaints with the CFPB, the FTC and my State Attorney General and will consider my remedies under 15 U.S.C. §1681n.",
  "You have 30 days under 15 U.S.C. §1681i(a)(1)(A) to finish this reinvestigation. Send me the results and a free updated report. A response that ignores the specific errors above will lead to complaints with the CFPB, the FTC and my State Attorney General, and I reserve my rights under 15 U.S.C. §1681n.",
  "I expect your results within the 30 days allowed by 15 U.S.C. §1681i(a)(1)(A), along with a corrected copy of my report. If you simply verify these items again, I will report the matter to the CFPB, the FTC and my State Attorney General and pursue the remedies available under 15 U.S.C. §1681n and §1681o.",
];

/* ------------------------------------------------------------------ */
/* Letter builders                                                      */
/* ------------------------------------------------------------------ */

function header(consumer: Consumer, recipient: Recipient, date: Date, subject: string): string {
  return [
    consumer.fullName,
    ...consumer.addressLines,
    "",
    formatDate(date),
    "",
    recipient.name,
    ...recipient.addressLines,
    "",
    `Re: ${subject}`,
  ].join("\n");
}

function signature(consumer: Consumer): string {
  return `Sincerely,\n\n\n${consumer.fullName}`;
}

export function bureauLetter(
  bureau: Bureau,
  items: DisputeItem[],
  round: Round,
  consumer: Consumer,
  date: Date,
  variant: number,
): Letter {
  const recipient = BUREAU_ADDRESSES[bureau];
  const b = BUREAU_NAME[bureau];
  const priorDate = items.map((i) => i.lastResponseDate).find(Boolean);
  const opening =
    round === 1
      ? BUREAU_OPEN_R1[variant % 3](b)
      : round === 2
        ? BUREAU_OPEN_R2[variant % 3](b, priorDate)
        : BUREAU_OPEN_R3[variant % 3](b);
  const subject =
    round === 1
      ? "Dispute of inaccurate information"
      : `Round ${round} dispute — results of your reinvestigation${priorDate ? ` dated ${priorDate}` : ""}`;

  const paragraphs = [
    opening,
    ...items.map((i) => itemParagraph(i, round, "bureau")),
    bureauLegalParagraph(round),
  ];
  if (round > 1) paragraphs.push(movParagraph());
  paragraphs.push(BUREAU_CLOSE[variant % 3]);

  const body = [header(consumer, recipient, date, subject), ...paragraphs, signature(consumer), ENCLOSURES_DEFAULT].join("\n\n");
  return {
    round,
    recipient,
    itemIds: items.map((i) => i.id),
    subject,
    body,
    enclosures: ENCLOSURES_DEFAULT,
    legalBasis: [
      "15 U.S.C. §1681i",
      "15 U.S.C. §1681e(b)",
      ...(round > 1 ? ["CFPB Circular 2022-07", "15 U.S.C. §1681i(a)(6)(B)(iii)", "15 U.S.C. §1681i(a)(7)"] : []),
      ...(items.some((i) => i.kind === "personal") ? ["15 U.S.C. §1681i(a)(5)(A)"] : []),
      ...(items.some((i) => i.reasons.includes("obsolete_negative")) ? ["15 U.S.C. §1681c(a)"] : []),
    ],
  };
}

const FURNISHER_OPEN = [
  (_n: string) => `You are reporting an account in my name to the credit bureaus, and the information is inaccurate. I am disputing it with you directly under 15 U.S.C. §1681s-2(a)(8) and 12 C.F.R. §1022.43.`,
  (n: string) => `I am writing to ${n} directly about information you furnish to the credit bureaus about me. Under 15 U.S.C. §1681s-2(a)(8) and Regulation V, 12 C.F.R. §1022.43, you must investigate this dispute yourself.`,
  (n: string) => `This is a direct dispute of your credit reporting under 12 C.F.R. §1022.43 and 15 U.S.C. §1681s-2(a)(8). What ${n} is sending the bureaus about me does not match the facts.`,
  (_n: string) => `Please accept this letter as my direct dispute, under 15 U.S.C. §1681s-2(a)(8), of the account you report on my credit files.`,
  (n: string) => `My credit reports show information from ${n} that I dispute as inaccurate. Federal law, 15 U.S.C. §1681s-2(a)(8), lets me dispute it with you directly, and I am doing so here.`,
  (n: string) => `I have reviewed how ${n} reports my account to the credit bureaus and found errors. I am disputing them directly with you under 12 C.F.R. §1022.43.`,
];

const COLLECTOR_OPEN = [
  (_n: string) => `You are reporting a collection account in my name. I dispute this debt and request validation under 15 U.S.C. §1692g.`,
  (n: string) => `I dispute the debt ${n} claims I owe and the way it appears on my credit reports. Under 15 U.S.C. §1692g I am requesting validation.`,
  (n: string) => `This letter disputes the collection account ${n} reports about me and requests validation of the alleged debt under the Fair Debt Collection Practices Act, 15 U.S.C. §1692g.`,
];

const EXPEDITE = [
  "Because the contradiction is visible in the data you already furnish, I ask that you process the deletion right away rather than holding it for the full 30 days.",
  "The error is confirmed by your own data across the three bureaus, so please correct or delete it promptly instead of waiting out the investigation period.",
  "Since your own reporting history shows the problem, there is no reason to wait. Please remove the tradeline immediately.",
  "Your own account records make this error plain, and I ask that you handle the deletion as soon as you receive this letter.",
  "Nothing outside your own file is needed to confirm this, so I am asking for the correction to be made immediately.",
  "This can be confirmed from records you already hold, and I would appreciate the deletion being processed without delay.",
];

const FURNISHER_CLOSE = [
  "Until this dispute is resolved, stop reporting the account as accurate and report it as disputed. If it is reported again without addressing these errors, I will file complaints with the CFPB and the FTC and consider my remedies under 15 U.S.C. §1681n.",
  "While you investigate, you may not continue reporting this information without noting that I dispute it. Continued inaccurate reporting will be reported to the CFPB and the FTC, and I reserve my rights under 15 U.S.C. §1681n.",
  "Please cease reporting this account until you have resolved my dispute. Otherwise I will escalate to the CFPB and the FTC and pursue the remedies available to me under 15 U.S.C. §1681n.",
  "If you cannot substantiate the disputed information from your own records, delete the tradeline from all three bureaus. Any further reporting without resolving this dispute will be raised with the CFPB and the FTC under 15 U.S.C. §1681n.",
  "I expect written confirmation of the correction or deletion. Reporting this account again as accurate will lead to complaints with the CFPB and the FTC and a claim under 15 U.S.C. §1681n.",
  "Stop furnishing this information until you have completed a real investigation. If the errors remain, I will file with the CFPB and the FTC and consider action under 15 U.S.C. §1681n.",
];

export function furnisherLetter(
  name: string,
  items: DisputeItem[],
  round: Round,
  consumer: Consumer,
  date: Date,
  variant: number,
  recipient?: Recipient,
): Letter & { needsAddress: boolean } {
  const isCollector = items.some((i) => i.isCollection);
  const to: Recipient = recipient ?? { kind: isCollector ? "collector" : "furnisher", name, addressLines: [] };
  const opening = isCollector
    ? COLLECTOR_OPEN[variant % COLLECTOR_OPEN.length](name)
    : FURNISHER_OPEN[variant % FURNISHER_OPEN.length](name);
  const subject = isCollector ? "Debt validation request and credit reporting dispute" : "Direct dispute of credit reporting";

  const paragraphs = [opening];
  // One paragraph per account (merge the same account across bureaus).
  const byAccount = new Map<string, DisputeItem>();
  for (const i of items) {
    const key = i.tradelineKey ?? i.name;
    const prev = byAccount.get(key);
    const full = (it: DisputeItem, r: DisputeReason) => {
      const ev = it.evidence?.[r] ?? {};
      return { ...(ev.others ?? {}), ...(ev.reported ? { [it.bureau]: ev.reported } : {}) } as Partial<Record<Bureau, string>>;
    };
    if (!prev) {
      const evidence: DisputeItem["evidence"] = {};
      for (const r of i.reasons) evidence[r] = { ...i.evidence?.[r], reported: undefined, others: full(i, r) };
      byAccount.set(key, { ...i, reasons: [...i.reasons], evidence });
      continue;
    }
    for (const r of i.reasons) {
      if (!prev.reasons.includes(r)) prev.reasons.push(r);
      const cur = prev.evidence[r] ?? {};
      prev.evidence[r] = { ...i.evidence?.[r], ...cur, reported: undefined, others: { ...(cur.others ?? {}), ...full(i, r) } };
    }
  }
  for (const i of byAccount.values()) paragraphs.push(itemParagraph(i, round, "furnisher"));

  if (round > 1) {
    paragraphs.push(
      "The credit bureaus forwarded my earlier dispute to you, which triggered your duty under 15 U.S.C. §1681s-2(b) to conduct a reasonable investigation and to delete or correct information you cannot verify. Confirming the same data does not meet that duty.",
    );
  }
  if (isCollector) {
    paragraphs.push(
      `Please provide ${numbered([
        "the name of the original creditor and the original account number",
        "a copy of the signed agreement or other proof that I owe this debt",
        "the complete payment history from the original creditor",
        "documentation of every sale or assignment that names this specific account, not a bulk portfolio list",
        "the Date of First Delinquency you report, and proof it matches the original creditor's date",
      ])}. Until you validate the debt, stop all collection activity.`,
    );
  }
  paragraphs.push(EXPEDITE[variant % EXPEDITE.length]);
  paragraphs.push(FURNISHER_CLOSE[variant % FURNISHER_CLOSE.length]);

  const enclosures = "Enclosure: Copy of my photo identification.";
  const body = [header(consumer, to, date, subject), ...paragraphs, signature(consumer), enclosures].join("\n\n");
  return {
    round,
    recipient: to,
    itemIds: items.map((i) => i.id),
    subject,
    body,
    enclosures,
    legalBasis: [
      "15 U.S.C. §1681s-2(a)(8)",
      "12 C.F.R. §1022.43",
      ...(round > 1 ? ["15 U.S.C. §1681s-2(b)"] : []),
      ...(isCollector ? ["15 U.S.C. §1692g"] : []),
    ],
    needsAddress: to.addressLines.length === 0,
  };
}
