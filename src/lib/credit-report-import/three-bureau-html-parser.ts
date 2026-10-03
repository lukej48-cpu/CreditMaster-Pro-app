/**
 * 3-Bureau HTML Report Parser
 *
 * Parses saved HTML reports from consumer monitoring services that show
 * TransUnion, Experian and Equifax side by side (IdentityIQ, MyScoreIQ,
 * SmartCredit and look-alikes) into a TriBureauReport.
 *
 * Strategy — layout-tolerant rather than CSS-class dependent:
 *  1. Walk the DOM in document order, emitting "heading" and "table" events.
 *  2. Headings that match known section names switch the current section;
 *     other short headings inside "Account History" are creditor names.
 *  3. A "bureau grid" is any table with a header row naming >= 2 bureaus.
 *     Each later row is `label | value per bureau`.
 *  4. A "history grid" is a table whose rows are labelled Month / Year /
 *     <bureau> (the 2-year payment history).
 *  5. An "inquiry table" has headers including Creditor + Bureau.
 *
 * The parser never throws on odd content; it records warnings and keeps
 * going, so one strange row can't block a client's whole import.
 */

import { parse, type HTMLElement, NodeType } from "node-html-parser";
import type { Bureau, PublicRecordType } from "@/types/credit-bureau";
import {
  BUREAUS,
  type BureauPersonalInfo,
  type BureauTradeline,
  type ImportedInquiry,
  type ImportedPublicRecord,
  type MergedTradeline,
  type PerBureau,
  type ReportSource,
  type TriBureauReport,
} from "./types";
import {
  cleanText,
  creditorKey,
  groupAddressLines,
  isEmptyValue,
  maskAccountNumber,
  monthIndex,
  parseAccountType,
  parseBureauName,
  parseHistoryCode,
  parseInteger,
  parseMoney,
  parsePaymentStatus,
  parseReportDate,
  parseScore,
  redactSsn,
} from "./normalize";

export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

type Section =
  | "none"
  | "personal"
  | "score"
  | "summary"
  | "accounts"
  | "inquiries"
  | "public"
  | "contacts";

/** A table row as label + per-bureau cell lines. */
interface GridRow {
  label: string;
  values: PerBureau<string[]>;
}

type DomEvent =
  | { kind: "heading"; text: string }
  | { kind: "table"; el: HTMLElement };

const SECTION_PATTERNS: Array<[RegExp, Section]> = [
  [/^personal (information|profile|info)/i, "personal"],
  [/^(credit )?scores?\b|^credit score/i, "score"],
  [/^(credit )?(report )?summary|^summary/i, "summary"],
  [/^account history|^accounts?$|^tradelines?|^credit accounts|^account details/i, "accounts"],
  [/^inquir/i, "inquiries"],
  [/^public (information|records?)/i, "public"],
  [/^creditor contacts?/i, "contacts"],
];

const HEADING_CLASS = /(header|heading|title|creditor|acct[-_]?name|account[-_]?name)/i;

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function detectReportSource(html: string): ReportSource {
  const lower = html.slice(0, 200_000).toLowerCase();
  if (lower.includes("identityiq")) return "identityiq";
  if (lower.includes("myscoreiq")) return "myscoreiq";
  if (lower.includes("smartcredit")) return "smartcredit";
  return "generic_3b_html";
}

/** Quick check used by the upload route before doing a full parse. */
export function looksLikeThreeBureauReport(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("transunion") &&
    lower.includes("experian") &&
    lower.includes("equifax") &&
    lower.includes("<table")
  );
}

export function parseThreeBureauHtml(rawHtml: string): TriBureauReport {
  if (!looksLikeThreeBureauReport(rawHtml)) {
    throw new ReportParseError(
      "This file doesn't look like a 3-bureau report. Upload the full report page saved as HTML from IdentityIQ, MyScoreIQ or SmartCredit.",
    );
  }

  const html = redactSsn(rawHtml);
  const root = parse(html, {
    blockTextElements: { script: false, style: false, noscript: false },
  });

  const report: TriBureauReport = {
    source: detectReportSource(html),
    scores: {},
    personal: {},
    tradelines: [],
    inquiries: [],
    publicRecords: [],
    bureausPresent: [],
    warnings: [],
  };

  const events: DomEvent[] = [];
  collectEvents(root, events);

  let section: Section = "none";
  let pendingCreditor: string | undefined;
  let lastTradeline: MergedTradeline | undefined;
  const keyCounts = new Map<string, number>();

  for (const ev of events) {
    if (ev.kind === "heading") {
      const s = matchSection(ev.text);
      if (s) {
        section = s;
        pendingCreditor = undefined;
        if (s !== "accounts") lastTradeline = undefined;
      } else if (section === "accounts" || section === "public") {
        pendingCreditor = ev.text;
      }
      continue;
    }

    const table = ev.el;

    // Payment history grid belongs to the most recent tradeline.
    const history = readHistoryGrid(table);
    if (history) {
      if (lastTradeline) applyHistory(lastTradeline, history);
      continue;
    }

    const inquiryRows = readInquiryTable(table, report.warnings);
    if (inquiryRows) {
      report.inquiries.push(...inquiryRows);
      section = "inquiries";
      continue;
    }

    const grid = readBureauGrid(table);
    if (!grid) continue;

    const labels = grid.map((r) => r.label.toLowerCase());
    const has = (re: RegExp) => labels.some((l) => re.test(l));

    if (has(/^credit score$|^score$|vantagescore|fico/)) {
      readScores(grid, report);
    }
    if (has(/^name$|date of birth|current address|also known as/)) {
      readPersonal(grid, report);
      continue;
    }
    if (has(/^account #$|^account number|^acct #/)) {
      const tl = readTradeline(grid, pendingCreditor, report.warnings);
      if (tl) {
        const n = (keyCounts.get(tl.key) ?? 0) + 1;
        keyCounts.set(tl.key, n);
        if (n > 1) tl.key = `${tl.key}#${n}`;
        report.tradelines.push(tl);
        lastTradeline = tl;
      }
      pendingCreditor = undefined;
      continue;
    }
    if (
      section === "public" ||
      has(/^date filed|^filing date|^court|^reference ?#|^case number/)
    ) {
      report.publicRecords.push(...readPublicRecord(grid, pendingCreditor));
      pendingCreditor = undefined;
    }
  }

  const reportDate = findReportDate(root);
  if (reportDate) report.reportDate = reportDate;

  report.bureausPresent = BUREAUS.filter(
    (b) =>
      report.scores[b] !== undefined ||
      report.personal[b] !== undefined ||
      report.tradelines.some((t) => t.bureaus[b]),
  );

  if (report.tradelines.length === 0 && report.bureausPresent.length === 0) {
    throw new ReportParseError(
      "No accounts or scores could be read from this file. Make sure you saved the full report page (not a summary or a login page).",
    );
  }

  return report;
}

/* ------------------------------------------------------------------ */
/* DOM walk                                                            */
/* ------------------------------------------------------------------ */

function collectEvents(node: HTMLElement, out: DomEvent[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName?.toLowerCase();
    if (!tag || tag === "script" || tag === "style" || tag === "noscript") continue;

    if (tag === "table") {
      // Tables nested inside a grid are handled by the grid itself; only
      // descend when this table is just a layout wrapper.
      if (isDataTable(el)) {
        out.push({ kind: "table", el });
      } else {
        collectEvents(el, out);
      }
      continue;
    }

    if (isHeading(el)) {
      const text = cleanText(el.text);
      if (text) out.push({ kind: "heading", text });
      continue;
    }

    collectEvents(el, out);
  }
}

function isHeading(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (el.querySelector("table")) return false;
  const text = cleanText(el.text);
  if (!text || text.length > 80) return false;
  if (/^h[1-6]$/.test(tag)) return true;
  const cls = el.getAttribute("class") ?? "";
  return HEADING_CLASS.test(cls) && !/label/i.test(cls);
}

function matchSection(text: string): Section | undefined {
  const t = cleanText(text).replace(/[:®™]/g, "");
  for (const [re, s] of SECTION_PATTERNS) if (re.test(t)) return s;
  return undefined;
}

/** Direct rows of a table (through thead/tbody), not rows of nested tables. */
function rowsOf(table: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const child of table.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "tr") rows.push(el);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const r of el.childNodes) {
        if (
          r.nodeType === NodeType.ELEMENT_NODE &&
          (r as HTMLElement).tagName.toLowerCase() === "tr"
        ) {
          rows.push(r as HTMLElement);
        }
      }
    }
  }
  return rows;
}

function cellsOf(row: HTMLElement): HTMLElement[] {
  return row.childNodes.filter(
    (c) =>
      c.nodeType === NodeType.ELEMENT_NODE &&
      ["td", "th"].includes((c as HTMLElement).tagName.toLowerCase()),
  ) as HTMLElement[];
}

/** Text of a cell split into lines (handles <br> and block children). */
function cellLines(cell: HTMLElement): string[] {
  return cell.structuredText
    .split("\n")
    .map(cleanText)
    .filter((l) => l.length > 0);
}

function cellText(cell: HTMLElement): string {
  return cleanText(cellLines(cell).join(" "));
}

function isDataTable(table: HTMLElement): boolean {
  return (
    bureauHeaderIndex(table) !== undefined ||
    readHistoryGrid(table) !== undefined ||
    isInquiryHeader(table)
  );
}

/* ------------------------------------------------------------------ */
/* Grid readers                                                        */
/* ------------------------------------------------------------------ */

function bureauHeaderIndex(
  table: HTMLElement,
): { rowIdx: number; columns: Map<number, Bureau> } | undefined {
  const rows = rowsOf(table);
  for (let i = 0; i < Math.min(rows.length, 3); i++) {
    const columns = new Map<number, Bureau>();
    cellsOf(rows[i]).forEach((c, idx) => {
      const b = parseBureauName(cellText(c));
      if (b) columns.set(idx, b);
    });
    if (columns.size >= 2) return { rowIdx: i, columns };
  }
  return undefined;
}

function readBureauGrid(table: HTMLElement): GridRow[] | undefined {
  const header = bureauHeaderIndex(table);
  if (!header) return undefined;
  const rows = rowsOf(table);
  const out: GridRow[] = [];
  for (let i = header.rowIdx + 1; i < rows.length; i++) {
    const cells = cellsOf(rows[i]);
    if (cells.length < 2) continue;
    const label = cellText(cells[0]).replace(/:\s*$/, "");
    if (!label) continue;
    const values: PerBureau<string[]> = {};
    for (const [idx, bureau] of header.columns) {
      const cell = cells[idx];
      if (!cell) continue;
      const lines = cellLines(cell).filter((l) => !isEmptyValue(l));
      if (lines.length) values[bureau] = lines;
    }
    out.push({ label, values });
  }
  return out;
}

function one(row: GridRow | undefined, b: Bureau): string | undefined {
  const v = row?.values[b];
  return v && v.length ? v.join(" ") : undefined;
}

function findRow(grid: GridRow[], re: RegExp): GridRow | undefined {
  return grid.find((r) => re.test(r.label.toLowerCase()));
}

function readScores(grid: GridRow[], report: TriBureauReport): void {
  const row = findRow(grid, /^credit score$|^score$|vantagescore|fico/);
  for (const b of BUREAUS) {
    const s = parseScore(one(row, b));
    if (s !== undefined) report.scores[b] = s;
  }
  const model = findRow(grid, /score (model|type)|^model/);
  const label = row?.label ?? "";
  if (/vantage/i.test(label)) report.scoreModel = "VantageScore";
  else if (/fico/i.test(label)) report.scoreModel = "FICO";
  if (model) {
    const text = BUREAUS.map((b) => one(model, b)).find(Boolean);
    if (text) report.scoreModel = text;
  }
}

function readPersonal(grid: GridRow[], report: TriBureauReport): void {
  for (const b of BUREAUS) {
    const lines = (re: RegExp) => findRow(grid, re)?.values[b] ?? [];
    const info: BureauPersonalInfo = {
      names: lines(/^name$/),
      akas: [...lines(/also known as|^aka/), ...lines(/^former/)],
      dateOfBirth: lines(/date of birth|^dob|birth year/)[0],
      currentAddresses: groupAddressLines(lines(/current address/)),
      previousAddresses: groupAddressLines(lines(/previous address|prior address/)),
      employers: lines(/employer/),
    };
    const hasData =
      info.names.length ||
      info.currentAddresses.length ||
      info.previousAddresses.length ||
      info.dateOfBirth;
    if (hasData) report.personal[b] = info;
  }
  const dateRow = findRow(grid, /report date/);
  if (dateRow && !report.reportDate) {
    const d = BUREAUS.map((b) => parseReportDate(one(dateRow, b))).find(Boolean);
    if (d) report.reportDate = d;
  }
}

function readTradeline(
  grid: GridRow[],
  creditor: string | undefined,
  warnings: string[],
): MergedTradeline | undefined {
  const get = (re: RegExp, b: Bureau) => one(findRow(grid, re), b);
  const bureaus: PerBureau<BureauTradeline> = {};

  for (const b of BUREAUS) {
    const acct = get(/^account #$|^account number|^acct #/, b);
    const balanceText = get(/^balance/, b);
    const statusText = get(/^payment status|^pay status/, b);
    const acctStatus = get(/^account status|^condition/, b);
    const opened = get(/^date opened|^opened/, b);
    // A bureau "reports" the account if any core field is present.
    if (!acct && !balanceText && !statusText && !acctStatus && !opened) continue;

    const typeText = get(/^account type$|^type$|^loan type/, b);
    const detailText = get(/^account type - detail|^account type detail|^detail/, b);
    const tl: BureauTradeline = {
      accountNumber: maskAccountNumber(acct),
      accountType: parseAccountType(typeText, detailText, creditor),
      accountTypeText: [typeText, detailText].filter(Boolean).join(" - ") || undefined,
      accountStatusText: acctStatus,
      paymentStatusText: statusText,
      paymentStatus: collectionAware(
        parsePaymentStatus(statusText, acctStatus),
        `${typeText ?? ""} ${detailText ?? ""}`,
      ),
      balance: parseMoney(balanceText),
      creditLimit: parseMoney(get(/^credit limit/, b)),
      highCredit: parseMoney(get(/^high (credit|balance)/, b)),
      pastDue: parseMoney(get(/^past due/, b)),
      monthlyPayment: parseMoney(get(/^monthly payment|^payment amount/, b)),
      openedDate: parseReportDate(opened),
      closedDate: parseReportDate(get(/^date closed|^closed/, b)),
      lastReportedDate: parseReportDate(get(/^last reported|^date reported/, b)),
      lastActiveDate: parseReportDate(get(/^date last active|^last active/, b)),
      lastPaymentDate: parseReportDate(get(/^date of last payment|^last payment/, b)),
      termMonths: parseInteger(get(/^no\. of months|^terms?\b|^term/, b)),
      responsibility: get(/^responsib|^bureau code|^ecoa/, b),
      comments: get(/^comments?|^remarks?/, b),
      history: {},
    };
    if (opened && !tl.openedDate) {
      warnings.push(`Could not read date opened "${opened}" (${creditor ?? "unknown creditor"}, ${b}).`);
    }
    bureaus[b] = tl;
  }

  if (Object.keys(bureaus).length === 0) return undefined;
  const name = cleanText(creditor) || "Unknown Creditor";
  if (!creditor) warnings.push("An account was found without a creditor name.");

  const isNegative = Object.values(bureaus).some((t) =>
    ["late_30", "late_60", "late_90", "late_120", "charge_off", "collection"].includes(
      t?.paymentStatus ?? "",
    ),
  );
  return { key: creditorKey(name) || "UNKNOWN", creditorName: name, bureaus, isNegative };
}

/**
 * Sites label both charge-offs and collections "Collection/Chargeoff". When
 * the account itself is a collection account, call it a collection.
 */
function collectionAware(
  status: BureauTradeline["paymentStatus"],
  typeText: string,
): BureauTradeline["paymentStatus"] {
  return status === "charge_off" && /collection/i.test(typeText) ? "collection" : status;
}

function readPublicRecord(
  grid: GridRow[],
  heading: string | undefined,
): ImportedPublicRecord[] {
  const out: ImportedPublicRecord[] = [];
  for (const b of BUREAUS) {
    const get = (re: RegExp) => one(findRow(grid, re), b);
    const typeText = get(/^type$|^record type/) ?? heading ?? "";
    const status = get(/^status/);
    const filed = get(/^date filed|^filing date|^date reported/);
    if (!typeText && !status && !filed) continue;
    out.push({
      recordType: publicRecordType(typeText),
      bureau: b,
      filingDate: parseReportDate(filed),
      status: status ?? "unknown",
      amount: parseMoney(get(/^amount|^liability|^asset amount/)),
      courtName: get(/^court/),
      caseNumber: get(/^reference ?#|^case number|^docket/),
    });
  }
  return out;
}

function publicRecordType(text: string): PublicRecordType {
  const t = text.toLowerCase();
  if (t.includes("bankrupt") || /chapter\s*(7|11|13)/.test(t)) return "bankruptcy";
  if (t.includes("lien")) return "tax_lien";
  if (t.includes("foreclos")) return "foreclosure";
  if (t.includes("repossess")) return "repossession";
  return "judgment";
}

/* ---------------- payment history ---------------- */

interface HistoryGrid {
  months: string[]; // YYYY-MM per column (index aligned with codes)
  codes: PerBureau<Array<string | undefined>>;
}

function readHistoryGrid(table: HTMLElement): HistoryGrid | undefined {
  const rows = rowsOf(table);
  let monthRow: string[] | undefined;
  let yearRow: string[] | undefined;
  const codes: PerBureau<Array<string | undefined>> = {};

  for (const row of rows) {
    const cells = cellsOf(row).map(cellText);
    if (cells.length < 3) continue;
    const label = cells[0].toLowerCase().replace(/:$/, "");
    if (label === "month") monthRow = cells.slice(1);
    else if (label === "year") yearRow = cells.slice(1);
    else {
      const b = parseBureauName(cells[0]);
      if (b) codes[b] = cells.slice(1);
    }
  }
  if (!monthRow || Object.keys(codes).length === 0) return undefined;

  const months: string[] = monthRow.map((m, i) => {
    const mi = monthIndex(m);
    let y = yearRow?.[i]?.replace(/[^0-9]/g, "");
    if (y && y.length === 2) y = `20${y}`;
    return mi && y ? `${y}-${String(mi).padStart(2, "0")}` : "";
  });
  return { months, codes };
}

function applyHistory(tl: MergedTradeline, grid: HistoryGrid): void {
  for (const b of BUREAUS) {
    const codes = grid.codes[b];
    const target = tl.bureaus[b];
    if (!codes || !target) continue;
    codes.forEach((code, i) => {
      const month = grid.months[i];
      const status = parseHistoryCode(code);
      if (month && status) target.history[month] = status;
    });
  }
  const lates = Object.values(tl.bureaus).some((t) =>
    Object.values(t?.history ?? {}).some((s) => s !== "current"),
  );
  if (lates) tl.isNegative = true;
}

/* ---------------- inquiries ---------------- */

function isInquiryHeader(table: HTMLElement): boolean {
  const first = rowsOf(table)[0];
  if (!first) return false;
  const text = cellsOf(first).map(cellText).join(" ").toLowerCase();
  return text.includes("creditor") && /bureau/.test(text) && /date/.test(text);
}

function readInquiryTable(
  table: HTMLElement,
  warnings: string[],
): ImportedInquiry[] | undefined {
  if (!isInquiryHeader(table)) return undefined;
  const rows = rowsOf(table);
  const header = cellsOf(rows[0]).map((c) => cellText(c).toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const iName = col(/creditor/);
  const iDate = col(/date/);
  const iBureau = col(/bureau/);
  const iBiz = col(/business|industry|type/);

  const out: ImportedInquiry[] = [];
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row).map(cellText);
    const name = cells[iName];
    if (!name || isEmptyValue(name)) continue;
    const bureau = parseBureauName(cells[iBureau]);
    if (!bureau) {
      warnings.push(`Inquiry "${name}" has no recognizable bureau; skipped.`);
      continue;
    }
    out.push({
      creditorName: name,
      date: parseReportDate(cells[iDate]),
      bureau,
      typeOfBusiness: iBiz >= 0 && cells[iBiz] && !isEmptyValue(cells[iBiz]) ? cells[iBiz] : undefined,
    });
  }
  return out;
}

/* ---------------- misc ---------------- */

function findReportDate(root: HTMLElement): Date | undefined {
  const text = cleanText(root.text).slice(0, 20_000);
  const m = text.match(/report date:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i);
  return m ? parseReportDate(m[1]) : undefined;
}
