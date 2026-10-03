/**
 * @jest-environment node
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CaseError,
  applyOutcomes,
  caseFromUpload,
  caseView,
  generatePackage,
  nextRound,
  type CaseRow,
  type FirmClient,
} from "@/lib/firm/case-service";
import { renderPacketPdf } from "@/lib/dispute-engine/pdf";

const HTML = readFileSync(
  join(__dirname, "../../credit-report-import/__tests__/fixtures/identityiq-sample.html"),
  "utf8",
);
const client: FirmClient = {
  id: "c1",
  owner_id: "u1",
  full_name: "Jane Q Sample",
  address_lines: ["100 Main St Apt 4", "Newark, NJ 07103"],
  state: "NJ",
};

function freshCase(): CaseRow {
  const { summary: _s, ...row } = caseFromUpload(Buffer.from(HTML), HTML);
  void _s;
  return { client_id: "c1", owner_id: "u1", ...row } as CaseRow;
}

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("firm case workflow", () => {
  it("imports a report into leads with stable ids and no stored HTML", () => {
    const row = freshCase();
    expect(row.leads.length).toBeGreaterThan(5);
    expect(row.leads.every((l) => typeof l.id === "string" && l.id.includes(":"))).toBe(true);
    expect(JSON.stringify(row)).not.toContain("<table");
    expect(JSON.stringify(row)).not.toContain("123-45-6789");
    expect(row.report_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(nextRound(row)).toBe(1);
  });

  it("refuses Round 1 with nothing confirmed and refuses out-of-order rounds", () => {
    const row = freshCase();
    expect(() => generatePackage(row, client, { round: 1, date: d("2026-10-05") })).toThrow(/Confirm at least one item/);
    expect(() => generatePackage(row, client, { round: 2, date: d("2026-10-05") })).toThrow(/next round is Round 1/);
  });

  it("runs one button → Round 1 package, results, Round 2 package", async () => {
    let row = freshCase();
    const confirmed = row.leads.filter((l) => l.severity === "high").map((l) => l.id);
    const r1 = generatePackage(row, client, { round: 1, confirmedLeadIds: confirmed, date: d("2026-10-05") });
    expect(r1.plan.letters.length).toBeGreaterThanOrEqual(3);
    expect(r1.timeline.responseDueOn).toBe("2026-11-09");
    row = { ...row, items: r1.items, rounds: r1.rounds };
    expect(nextRound(row)).toBeNull(); // waiting on results

    const pdf = await renderPacketPdf(r1.plan, { clientName: client.full_name, timeline: r1.timeline });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);

    const results = Object.fromEntries(row.items.map((i, k) => [i.id, k === 0 ? "deleted" : "verified"]));
    row = { ...row, items: applyOutcomes(row, results, "11/06/2026") };
    expect(nextRound(row)).toBe(2);

    const r2 = generatePackage(row, client, { round: 2, date: d("2026-11-19") });
    expect(r2.plan.letters[0].body).toContain("dated 11/06/2026");
    expect(r2.plan.letters.flatMap((l) => l.itemIds)).not.toContain(row.items[0].id);

    const view = caseView({ ...row, items: r2.items, rounds: r2.rounds });
    expect(view.readiness?.score).toBeGreaterThan(0);
    expect(view.rounds).toHaveLength(2);
  });

  it("validates recorded results", () => {
    const row = freshCase();
    expect(() => applyOutcomes(row, { nope: "deleted" })).toThrow(CaseError);
    const r1 = generatePackage(row, client, { round: 1, confirmedLeadIds: [row.leads[0].id], date: d("2026-10-05") });
    const withItems = { ...row, items: r1.items, rounds: r1.rounds };
    const id = withItems.items[0].id;
    expect(() => applyOutcomes(withItems, { [id]: "won" })).toThrow(/Invalid result/);
    expect(() => applyOutcomes(withItems, { [id]: "deleted" }, "2026-11-06")).toThrow(/MM\/DD\/YYYY/);
  });

  it("requires a mailing address", () => {
    const row = freshCase();
    expect(() =>
      generatePackage(row, { ...client, address_lines: [] }, { round: 1, confirmedLeadIds: [row.leads[0].id], date: d("2026-10-05") }),
    ).toThrow(/mailing address/);
  });
});
