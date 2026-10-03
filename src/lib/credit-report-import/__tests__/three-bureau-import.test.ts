/**
 * @jest-environment node
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeCrossBureau,
  parseThreeBureauHtml,
  ReportParseError,
  summarizeImport,
  toBureauSlices,
  type Discrepancy,
  type TriBureauReport,
} from "@/lib/credit-report-import";
import {
  groupAddressLines,
  maskAccountNumber,
  parseHistoryCode,
  parseMoney,
  parsePaymentStatus,
  parseReportDate,
  redactSsn,
} from "@/lib/credit-report-import/normalize";

const FIXTURE = readFileSync(
  join(__dirname, "fixtures", "identityiq-sample.html"),
  "utf8",
);

function find(list: Discrepancy[], type: Discrepancy["type"], creditor?: string) {
  return list.filter(
    (d) => d.type === type && (creditor === undefined || d.creditorName === creditor),
  );
}

describe("normalize", () => {
  it("parses money, including negatives and empty tokens", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("($50)")).toBe(-50);
    expect(parseMoney("-")).toBeUndefined();
    expect(parseMoney("n/a")).toBeUndefined();
  });

  it("parses the date formats reports use", () => {
    expect(parseReportDate("03/15/2019")?.toISOString()).toBe("2019-03-15T00:00:00.000Z");
    expect(parseReportDate("11/2020")?.toISOString()).toBe("2020-11-01T00:00:00.000Z");
    expect(parseReportDate("2021-06-02")?.toISOString()).toBe("2021-06-02T00:00:00.000Z");
    expect(parseReportDate("Mar 2019")?.toISOString()).toBe("2019-03-01T00:00:00.000Z");
    expect(parseReportDate("13/40/2019")).toBeUndefined();
    expect(parseReportDate("-")).toBeUndefined();
  });

  it("normalizes payment status text", () => {
    expect(parsePaymentStatus("Current", "Open")).toBe("current");
    expect(parsePaymentStatus("Current", "Closed")).toBe("closed");
    expect(parsePaymentStatus("Late 60 Days")).toBe("late_60");
    expect(parsePaymentStatus("Collection/Chargeoff")).toBe("charge_off");
    expect(parsePaymentStatus("Collection")).toBe("collection");
    expect(parsePaymentStatus("Paid as agreed")).toBe("current");
  });

  it("maps history grid codes", () => {
    expect(parseHistoryCode("OK")).toBe("current");
    expect(parseHistoryCode("30")).toBe("late_30");
    expect(parseHistoryCode("CO")).toBe("charge_off");
    expect(parseHistoryCode("")).toBeUndefined();
  });

  it("masks account numbers keeping only the visible 4", () => {
    expect(maskAccountNumber("517805******1234")).toBe("****1234");
    expect(maskAccountNumber("517805XXXXXX1234")).toBe("****1234");
    expect(maskAccountNumber("8834****")).toBe("8834****");
    expect(maskAccountNumber("-")).toBe("");
  });

  it("redacts full SSNs", () => {
    expect(redactSsn("ssn 123-45-6789 ok")).toBe("ssn XXX-XX-XXXX ok");
    expect(redactSsn("SSN: 123456789")).toBe("SSN: XXXXXXXXX");
  });

  it("groups address lines into whole addresses", () => {
    expect(
      groupAddressLines(["1 A ST", "LA, CA 90028", "2 B AVE", "NEWARK, NJ 07102"]),
    ).toEqual(["1 A ST, LA, CA 90028", "2 B AVE, NEWARK, NJ 07102"]);
  });
});

describe("parseThreeBureauHtml (IdentityIQ layout)", () => {
  let report: TriBureauReport;
  beforeAll(() => {
    report = parseThreeBureauHtml(FIXTURE);
  });

  it("detects source, date, scores and bureaus", () => {
    expect(report.source).toBe("identityiq");
    expect(report.reportDate?.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(report.scores).toEqual({ transunion: 612, experian: 598, equifax: 605 });
    expect(report.bureausPresent).toEqual(["transunion", "experian", "equifax"]);
    expect(report.scoreModel).toBeUndefined();
  });

  it("never carries the full SSN anywhere in the result", () => {
    expect(JSON.stringify(report)).not.toContain("123-45-6789");
  });

  it("reads personal info per bureau with whole addresses", () => {
    expect(report.personal.experian?.akas).toEqual(["JANE SAMPLES"]);
    expect(report.personal.equifax?.dateOfBirth).toBe("1987");
    expect(report.personal.transunion?.currentAddresses).toEqual([
      "100 MAIN ST APT 4, LOS ANGELES, CA 90028",
    ]);
    expect(report.personal.transunion?.previousAddresses).toEqual([
      "55 ELM AVE, NEWARK, NJ 07102",
    ]);
  });

  it("reads every tradeline, merged across bureaus", () => {
    expect(report.tradelines.map((t) => t.key)).toEqual([
      "CAPITAL ONE",
      "MIDLAND CREDIT MANAGEMENT",
      "SYNCB AMAZON",
      "TOYOTA MOTOR CREDIT",
      "CAPITAL ONE#2",
    ]);
    const midland = report.tradelines[1];
    expect(Object.keys(midland.bureaus).sort()).toEqual(["equifax", "transunion"]);
    expect(midland.bureaus.transunion?.paymentStatus).toBe("collection");
    expect(midland.bureaus.transunion?.accountNumber).toBe("8834****");
    expect(midland.bureaus.equifax?.balance).toBe(910);

    const toyota = report.tradelines[3];
    expect(toyota.isNegative).toBe(false);
    expect(toyota.bureaus.experian?.accountType).toBe("auto_loan");
    expect(toyota.bureaus.experian?.termMonths).toBe(60);
  });

  it("attaches the 2-year payment history to the right account", () => {
    const cap1 = report.tradelines[0];
    expect(cap1.bureaus.experian?.history["2026-03"]).toBe("late_30");
    expect(cap1.bureaus.transunion?.history["2026-03"]).toBe("current");
    expect(cap1.bureaus.equifax?.history["2026-05"]).toBeUndefined();
    expect(cap1.isNegative).toBe(true);
    expect(Object.keys(report.tradelines[1].bureaus.transunion!.history)).toHaveLength(0);
  });

  it("reads inquiries but not the creditor-contacts table", () => {
    expect(report.inquiries.map((i) => [i.creditorName, i.bureau])).toEqual([
      ["TOYOTA MOTOR CREDIT", "experian"],
      ["CREDIT ONE BANK", "transunion"],
      ["OLD FINANCE CO", "equifax"],
    ]);
    expect(report.publicRecords).toHaveLength(0);
  });

  it("rejects files that are not 3-bureau reports", () => {
    expect(() => parseThreeBureauHtml("<html><body>Login</body></html>")).toThrow(
      ReportParseError,
    );
    expect(() =>
      parseThreeBureauHtml("<p>TransUnion Experian Equifax</p><table></table>"),
    ).toThrow(/No accounts or scores/);
  });
});

describe("analyzeCrossBureau", () => {
  let leads: Discrepancy[];
  beforeAll(() => {
    leads = analyzeCrossBureau(parseThreeBureauHtml(FIXTURE));
  });

  it("flags a late payment only one bureau reports", () => {
    const [d] = find(leads, "late_history_mismatch", "CAPITAL ONE");
    expect(d.severity).toBe("high");
    expect(d.bureaus).toEqual(["experian"]);
    expect(d.values).toEqual({ experian: "2026-03" });
  });

  it("flags different balances on a collection and its uneven reporting", () => {
    expect(find(leads, "balance_mismatch", "MIDLAND CREDIT MANAGEMENT")[0]).toMatchObject({
      severity: "high",
      bureaus: ["equifax"],
    });
    expect(find(leads, "missing_on_bureau", "MIDLAND CREDIT MANAGEMENT")[0].bureaus).toEqual([
      "transunion",
      "equifax",
    ]);
    expect(find(leads, "date_opened_mismatch", "MIDLAND CREDIT MANAGEMENT")).toHaveLength(1);
  });

  it("flags past-due mismatch and obsolete charge-off", () => {
    expect(find(leads, "past_due_mismatch", "SYNCB/AMAZON")[0].bureaus).toEqual([
      "transunion",
      "experian",
    ]);
    expect(find(leads, "obsolete_negative", "SYNCB/AMAZON")[0].legalBasis).toMatch(/§605/);
  });

  it("does not flag small timing differences or clean accounts", () => {
    // Capital One open dates differ by 11 days — under the 31-day threshold.
    expect(find(leads, "date_opened_mismatch", "CAPITAL ONE")).toHaveLength(0);
    expect(leads.filter((d) => d.creditorName?.startsWith("TOYOTA"))).toHaveLength(0);
    // Positive account on one bureau only isn't a dispute lead.
    expect(find(leads, "missing_on_bureau", "CAPITAL ONE")).toHaveLength(0);
    expect(find(leads, "inconsistent_account_number")).toHaveLength(0);
  });

  it("flags lower credit limit, inquiries and identity variations", () => {
    expect(find(leads, "credit_limit_mismatch", "CAPITAL ONE")[0].bureaus).toEqual(["equifax"]);
    expect(find(leads, "aged_inquiry")[0].creditorName).toBe("OLD FINANCE CO");
    expect(find(leads, "unmatched_inquiry").map((d) => d.creditorName)).toEqual([
      "CREDIT ONE BANK",
    ]);
    expect(find(leads, "dob_mismatch")).toHaveLength(1);
    expect(find(leads, "name_variation")[0].bureaus).toEqual(["experian"]);
    expect(find(leads, "address_variation")[0].bureaus).toEqual(["transunion"]);
  });

  it("orders leads high → low", () => {
    const order = leads.map((d) => d.severity);
    const rank = { high: 0, medium: 1, low: 2 };
    expect(order).toEqual([...order].sort((a, b) => rank[a] - rank[b]));
  });
});

describe("toBureauSlices / summarizeImport", () => {
  const report = parseThreeBureauHtml(FIXTURE);
  const leads = analyzeCrossBureau(report);
  const slices = toBureauSlices(report, leads, {
    userId: "user-1",
    importId: "imp-1",
    fileName: "report.html",
    fileSha256: "abc",
    today: new Date("2026-10-01T00:00:00Z"),
  });

  it("produces one slice per bureau with DB-shaped rows", () => {
    expect(slices.map((s) => s.bureau)).toEqual(["transunion", "experian", "equifax"]);
    const tu = slices[0];
    expect(tu.report).toMatchObject({
      user_id: "user-1",
      bureau: "transunion",
      report_date: "2026-09-15",
      credit_score: 612,
    });
    expect(tu.accounts).toHaveLength(5);
    expect(slices[1].accounts).toHaveLength(3); // Experian
    expect(tu.accounts[0]).toMatchObject({
      creditor_name: "CAPITAL ONE",
      account_number: "****1234",
      opened_date: "2019-04-12",
      balance: 1250,
    });
    expect(tu.inquiries).toHaveLength(1);
  });

  it("never stores the uploaded HTML, only its hash", () => {
    const raw = slices[0].report.raw_data as Record<string, unknown>;
    expect(raw.file_sha256).toBe("abc");
    expect(JSON.stringify(slices)).not.toContain("<table");
  });

  it("keeps only each bureau's own leads in its slice", () => {
    const eq = slices[2].report.parsed_data as { discrepancies: Discrepancy[] };
    expect(eq.discrepancies.every((d) => d.bureaus.includes("equifax"))).toBe(true);
  });

  it("summarizes counts", () => {
    const s = summarizeImport(report, leads);
    expect(s.accounts).toBe(5);
    expect(s.negativeAccounts).toBe(3);
    expect(s.discrepancies.total).toBe(leads.length);
    expect(s.discrepancies.high).toBeGreaterThanOrEqual(4);
  });
});
