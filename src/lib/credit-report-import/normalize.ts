/**
 * Value normalizers for 3-bureau report imports.
 *
 * Consumer-facing monitoring sites (IdentityIQ, MyScoreIQ, SmartCredit, ...)
 * render every value as display text: "$1,234", "03/15/2019", "-", "Charge
 * off", "Collection/Chargeoff", etc. These helpers turn that text into typed
 * values and never throw — an unparseable value becomes `undefined` so the
 * caller can record a warning instead of failing the whole import.
 */

import type {
  AccountType,
  Bureau,
  PaymentStatus,
} from "@/types/credit-bureau";

/** Values sites use to mean "nothing reported for this bureau". */
const EMPTY_TOKENS = new Set(["", "-", "--", "—", "n/a", "na", "none", "null"]);

export function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isEmptyValue(value: string | null | undefined): boolean {
  return EMPTY_TOKENS.has(cleanText(value).toLowerCase());
}

/** "$1,234.56" -> 1234.56 ; "($50)" -> -50 ; "-" -> undefined */
export function parseMoney(value: string | null | undefined): number | undefined {
  const text = cleanText(value);
  if (isEmptyValue(text)) return undefined;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const digits = text.replace(/[^0-9.]/g, "");
  if (!digits || !/\d/.test(digits)) return undefined;
  const n = Number.parseFloat(digits);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

export function parseInteger(value: string | null | undefined): number | undefined {
  const text = cleanText(value);
  if (isEmptyValue(text)) return undefined;
  const m = text.match(/-?\d[\d,]*/);
  if (!m) return undefined;
  const n = Number.parseInt(m[0].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the date formats these reports use. Returns a UTC-midnight Date.
 * Supports MM/DD/YYYY, MM/YYYY, MM/DD/YY, YYYY-MM-DD, "Mar 2019", "March 15, 2019".
 */
export function parseReportDate(value: string | null | undefined): Date | undefined {
  const text = cleanText(value);
  if (isEmptyValue(text)) return undefined;

  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return utc(+m[1], +m[2], +m[3]);

  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += year > 50 ? 1900 : 2000;
    return utc(year, +m[1], +m[2]);
  }

  m = text.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return utc(+m[2], +m[1], 1);

  m = text.match(/^([A-Za-z]{3,9})\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return utc(+m[3], month, m[2] ? +m[2] : 1);
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function monthIndex(name: string): number | undefined {
  return MONTHS[cleanText(name).slice(0, 3).toLowerCase()];
}

function utc(year: number, month: number, day: number): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) {
    return undefined;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function toIsoDate(d: Date | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Map a bureau header cell ("TransUnion", "TUC", "EXP", "Equifax®") to a Bureau. */
export function parseBureauName(value: string | null | undefined): Bureau | undefined {
  const t = cleanText(value).toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return undefined;
  if (t.startsWith("transunion") || t === "tu" || t === "tuc") return "transunion";
  if (t.startsWith("experian") || t === "exp" || t === "ex") return "experian";
  if (t.startsWith("equifax") || t === "eqf" || t === "efx" || t === "eq") return "equifax";
  return undefined;
}

/**
 * Normalize an account's status text into the app's PaymentStatus.
 * Considers both "Account Status" (Open/Closed/Derogatory) and
 * "Payment Status" (Current / Late 30 Days / Collection/Chargeoff).
 */
export function parsePaymentStatus(
  paymentStatus: string | undefined,
  accountStatus?: string,
): PaymentStatus | undefined {
  const p = cleanText(paymentStatus).toLowerCase();
  const a = cleanText(accountStatus).toLowerCase();
  const both = `${p} ${a}`;

  if (/charge\s*-?\s*off|chargeoff|charged off/.test(both)) {
    // "Collection/Chargeoff" is how several sites label charge-offs.
    return /collection/.test(p) && !/charge/.test(p) ? "collection" : "charge_off";
  }
  if (/collection|placed for collection/.test(both)) return "collection";
  if (/120|150|180/.test(p)) return "late_120";
  if (/\b90\b/.test(p)) return "late_90";
  if (/\b60\b/.test(p)) return "late_60";
  if (/\b30\b/.test(p)) return "late_30";
  if (/repossession|foreclos/.test(both)) return "charge_off";
  if (/current|pays as agreed|paid as agreed|never late|^ok$/.test(p)) {
    return a.includes("closed") ? "closed" : "current";
  }
  if (/closed|paid/.test(both)) return "closed";
  if (/open/.test(a)) return "current";
  return undefined;
}

/** Map a 2-year payment-history grid cell to a PaymentStatus (or undefined = no data). */
export function parseHistoryCode(code: string | null | undefined): PaymentStatus | undefined {
  const c = cleanText(code).toUpperCase();
  if (!c || c === "-" || c === "ND" || c === "NR" || c === "X") return undefined;
  if (c === "OK" || c === "C" || c === "E" || c === "0") return "current";
  if (c === "30") return "late_30";
  if (c === "60") return "late_60";
  if (c === "90") return "late_90";
  if (["120", "150", "180"].includes(c)) return "late_120";
  if (c === "CO" || c === "C/O" || c === "R" || c === "FC" || c === "B") return "charge_off";
  if (c === "COL" || c === "CA" || c === "V") return "collection";
  return undefined;
}

export function parseAccountType(
  typeText: string | undefined,
  detailText?: string,
  creditorName?: string,
): AccountType {
  const t = `${cleanText(typeText)} ${cleanText(detailText)}`.toLowerCase();
  if (/mortgage|real estate|heloc|home equity/.test(t)) return "mortgage";
  if (/auto|vehicle|car loan/.test(t)) return "auto_loan";
  if (/student|education/.test(t)) return "student_loan";
  if (/credit card|charge card|revolving charge|flexible spending/.test(t)) return "credit_card";
  if (/personal|unsecured|signature/.test(t)) return "personal_loan";
  if (/revolving|line of credit/.test(t)) return "revolving";
  if (/installment/.test(t)) return "installment";
  // Collections, medical, utilities, unknown: the app has no dedicated type.
  void creditorName;
  return "other";
}

/**
 * Mask an account number, keeping the 4 characters the bureau left visible.
 * "517805******1234" -> "****1234" ; "8834****" -> "8834****" (prefix-visible,
 * common on collection accounts).
 */
export function maskAccountNumber(value: string | null | undefined): string {
  const t = cleanText(value).replace(/\s/g, "");
  if (isEmptyValue(t)) return "";
  const prefixVisible = /[*Xx#]+$/.test(t) && /^[0-9A-Za-z]/.test(t);
  const visible = t.replace(/[^0-9A-Za-z]/g, "").replace(/[Xx]+/g, "");
  if (!visible) return "";
  return prefixVisible ? `${visible.slice(0, 4)}****` : `****${visible.slice(-4)}`;
}

/** Last 4 digits if the masked number is suffix-visible, else undefined. */
export function accountLast4(masked: string): string | undefined {
  return masked.startsWith("****") ? masked.slice(-4) : undefined;
}

/**
 * Group address lines into whole addresses. Reports put street and
 * "CITY, ST 12345" on separate lines; a line ending in a ZIP closes one.
 */
export function groupAddressLines(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    current.push(line);
    if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/i.test(line)) {
      out.push(current.join(", "));
      current = [];
    }
  }
  if (current.length) out.push(current.join(", "));
  return out;
}

/**
 * Remove full SSNs (and SSN-like 9-digit runs) from free text. Reports
 * usually show only the last 4, but saved pages sometimes carry the full
 * number in hidden fields — it must never reach storage or logs.
 */
export function redactSsn(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "XXX-XX-XXXX")
    .replace(/\b(?:ssn|social security)[^0-9]{0,20}\d{9}\b/gi, (m) =>
      m.replace(/\d{9}$/, "XXXXXXXXX"),
    );
}

/** Credit score in a plausible range, else undefined. */
export function parseScore(value: string | null | undefined): number | undefined {
  const n = parseInteger(value);
  return n !== undefined && n >= 300 && n <= 900 ? n : undefined;
}

/** Normalized creditor key used to match the same tradeline across bureaus. */
export function creditorKey(name: string): string {
  return cleanText(name)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(INC|LLC|NA|N A|CORP|CO|BANK|FSB|THE)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
