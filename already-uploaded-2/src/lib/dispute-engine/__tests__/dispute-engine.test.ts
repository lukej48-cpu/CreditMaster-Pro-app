/**
 * @jest-environment node
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCrossBureau, parseThreeBureauHtml } from "@/lib/credit-report-import";
import {
  buildDisputeItems,
  computeReadiness,
  escalationCandidates,
  leadId,
  markMailed,
  planRound,
  recordOutcomes,
  roundTimeline,
  type DisputeItem,
  type Letter,
  type Outcome,
} from "@/lib/dispute-engine";

const HTML = readFileSync(
  join(__dirname, "../../credit-report-import/__tests__/fixtures/identityiq-sample.html"),
  "utf8",
);
const report = parseThreeBureauHtml(HTML);
const leads = analyzeCrossBureau(report);
const consumer = {
  fullName: "Jane Q Sample",
  addressLines: ["100 Main St Apt 4", "Los Angeles, CA 90028"],
  state: "CA",
};
const opts = { consumer, date: new Date("2026-10-05T00:00:00Z") };

function allItems(): DisputeItem[] {
  return buildDisputeItems(report, leads, leads.map(leadId));
}

function bodyOf(l: Letter): string {
  // Everything after the "Re:" line.
  return l.body.slice(l.body.indexOf("\n\n", l.body.indexOf("Re: ")) + 2);
}

function letterTo(letters: Letter[], name: RegExp): Letter {
  const l = letters.find((x) => name.test(x.recipient.name));
  if (!l) throw new Error(`no letter to ${name}`);
  return l;
}

describe("buildDisputeItems", () => {
  it("only includes leads the client confirmed", () => {
    expect(buildDisputeItems(report, leads, [])).toHaveLength(0);
    const one = leads.find((d) => d.type === "late_history_mismatch")!;
    const items = buildDisputeItems(report, leads, [leadId(one)]);
    expect(items.map((i) => i.id)).toEqual(["account:CAPITAL ONE:experian"]);
  });

  it("merges reasons per account per bureau and keeps evidence per reason", () => {
    const midland = allItems().find((i) => i.id === "account:MIDLAND CREDIT MANAGEMENT:equifax")!;
    expect(midland.reasons.sort()).toEqual(["balance_mismatch", "date_opened_mismatch", "missing_on_bureau"]);
    expect(midland.evidence.balance_mismatch?.reported).toBe("$910");
    expect(midland.evidence.date_opened_mismatch?.reported).toBe("2021-06-02");
    expect(midland.evidence.missing_on_bureau?.missingFrom).toEqual(["experian"]);
    expect(midland.isCollection).toBe(true);
  });

  it("disputes a date of birth only on the bureau reporting the odd value", () => {
    const dob = allItems().filter((i) => i.reasons.includes("dob_mismatch"));
    expect(dob.map((i) => i.bureau)).toEqual(["equifax"]);
  });

  it("adds client claims the report can't show", () => {
    const items = buildDisputeItems(report, leads, [], [
      { kind: "account", bureaus: ["transunion", "equifax"], subject: "TOYOTA MOTOR CREDIT", reason: "not_mine" },
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "account:TOYOTA MOTOR CREDIT:transunion",
      "account:TOYOTA MOTOR CREDIT:equifax",
    ]);
    expect(items[0].name).toBe("TOYOTA MOTOR CREDIT CO");
  });
});

describe("Round 1 plan", () => {
  const plan = planRound(allItems(), 1, opts);

  it("writes one letter per bureau plus one per furnisher/collector", () => {
    expect(plan.letters.map((l) => l.recipient.name)).toEqual([
      "TransUnion Consumer Solutions",
      "Experian",
      "Equifax Information Services LLC",
      "CAPITAL ONE",
      "MIDLAND CREDIT MANAGEMENT",
      "SYNCB/AMAZON",
    ]);
    expect(letterTo(plan.letters, /MIDLAND/).recipient.kind).toBe("collector");
    expect(letterTo(plan.letters, /MIDLAND/).legalBasis).toContain("15 U.S.C. §1692g");
  });

  it("states each conflict with the right bureau and value", () => {
    const eq = bodyOf(letterTo(plan.letters, /Equifax/));
    expect(eq).toContain("You report the balance as $910, while TransUnion reports $842.");
    expect(eq).toContain("does not appear on my Experian report");
    expect(eq).toContain("You show this account as opened 06/02/2021, while TransUnion reports 01/15/2021.");
    expect(eq).toContain("Metro 2 Field 21 (Current Balance)");

    const cap1 = bodyOf(letterTo(plan.letters, /CAPITAL ONE/));
    expect(cap1).toContain("$1,500 to TransUnion");
    expect(cap1).toContain("$1,500 to Experian");
    expect(cap1).toContain("$1,000 to Equifax");
    expect(cap1).toContain("late payment in March 2026 to Experian");
  });

  it("never cites an agreeing bureau as a conflict", () => {
    const tu = bodyOf(letterTo(plan.letters, /TransUnion/));
    expect(tu).toContain("The past-due amount you show is $1,100, yet Equifax reports $0.");
    expect(tu).not.toMatch(/Experian reports \$1,100/);
  });

  it("frames confirmed personal-info errors under §1681i(a)(5)(A)", () => {
    const ex = bodyOf(letterTo(plan.letters, /^Experian$/));
    expect(ex).toContain('lists the name "JANE SAMPLES". I have never used that name.');
    expect(ex).toContain("§1681i(a)(5)(A)");
  });

  it("follows the firm letter standard", () => {
    for (const l of plan.letters) {
      const body = bodyOf(l);
      expect(body).not.toMatch(/^\s*[•\-*] /m); // no bullets
      expect(body).not.toMatch(/\*\*[A-Za-z]/); // no bold markup (masked numbers like ****1234 are fine)
      expect(body).not.toContain("—"); // no em-dashes in the body
      expect(body).not.toMatch(/\d{3}-\d{2}-\d{4}/); // no SSN
      expect(body).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/); // dates are MM/DD/YYYY
      expect(body).not.toMatch(/\b(furthermore|moreover|delve|crucial|leverage)\b/i);
      expect(body).toContain("Sincerely,");
    }
    for (const l of plan.letters.filter((x) => x.recipient.kind === "bureau")) {
      expect(l.enclosures).toMatch(/photo ID \(front and back\); proof of Social Security Number; proof of current address/);
    }
  });

  it("gives every letter in the packet a different opening and closing", () => {
    const paras = plan.letters.map((l) => bodyOf(l).split("\n\n"));
    const openings = paras.map((p) => p[0]);
    const closings = paras.map((p) => p[p.length - 4]); // paragraph before signature
    expect(new Set(openings).size).toBe(openings.length);
    expect(new Set(closings).size).toBe(closings.length);
  });

  it("flags furnisher letters that still need a mailing address", () => {
    const f = letterTo(plan.letters, /SYNCB/) as Letter & { needsAddress?: boolean };
    expect(f.needsAddress).toBe(true);
  });
});

describe("Rounds 2 and 3", () => {
  function through(round: 2 | 3, outcome: (i: DisputeItem, k: number) => Outcome) {
    let items = allItems();
    let plan = planRound(items, 1, opts);
    items = markMailed(items, plan);
    items = recordOutcomes(items, Object.fromEntries(items.map((i, k) => [i.id, outcome(i, k)])), "11/06/2026");
    if (round === 3) {
      plan = planRound(items, 2, opts);
      items = markMailed(items, plan);
      items = recordOutcomes(items, Object.fromEntries(items.map((i, k) => [i.id, outcome(i, k)])), "12/22/2026");
    }
    return items;
  }

  it("Round 2 only carries verified / no-response items and attacks the prior response", () => {
    const items = through(2, (i) => (i.kind === "personal" ? "deleted" : "verified"));
    const plan = planRound(items, 2, opts);
    expect(plan.letters.flatMap((l) => l.itemIds).some((id) => id.startsWith("personal"))).toBe(false);
    const eq = letterTo(plan.letters, /Equifax/);
    expect(eq.subject).toBe("Round 2 dispute — results of your reinvestigation dated 11/06/2026");
    const body = bodyOf(eq);
    expect(body).toContain("Circular 2022-07");
    expect(body).toContain("§1681i(a)(6)(B)(iii)");
    expect(body).toContain("you marked this item verified");
    const furnisher = bodyOf(letterTo(plan.letters, /SYNCB/));
    expect(furnisher).toContain("15 U.S.C. §1681s-2(b)");
  });

  it("sends updated items back to the client instead of re-disputing", () => {
    const items = through(2, () => "updated");
    const plan = planRound(items, 2, opts);
    expect(plan.letters).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/client to confirm/);
  });

  it("Round 3 escalates and flags survivors for CFPB / attorney review", () => {
    const items = through(3, () => "verified");
    const plan = planRound(items, 3, opts);
    expect(bodyOf(letterTo(plan.letters, /TransUnion/))).toMatch(/third written dispute|twice|two prior disputes/);
    const after = recordOutcomes(markMailed(items, plan), Object.fromEntries(items.map((i) => [i.id, "verified" as Outcome])));
    expect(escalationCandidates(after).length).toBeGreaterThan(0);
  });

  it("refuses to skip a round", () => {
    const plan = planRound(allItems(), 2, opts);
    expect(plan.letters).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/Needs a Round 1 outcome/);
  });
});

describe("roundTimeline", () => {
  it("computes the FCRA response window and the day-45 next round", () => {
    expect(roundTimeline(1, "2026-10-05")).toEqual({
      round: 1,
      mailedOn: "2026-10-05",
      responseDueOn: "2026-11-09",
      extendedDueOn: "2026-11-24",
      nextRoundEligibleOn: "2026-11-19",
    });
  });
});

describe("computeReadiness (underwriting hand-off)", () => {
  it("scores the file and lists failed gates", () => {
    const r = computeReadiness(report);
    expect(r.ready).toBe(false);
    const failed = r.gates.filter((g) => !g.passed).map((g) => g.id);
    expect(failed).toEqual(expect.arrayContaining(["score", "derogatories", "utilization"]));
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
  });

  it("improves as disputed items are deleted", () => {
    const before = computeReadiness(report);
    let items = allItems();
    items = markMailed(items, planRound(items, 1, opts));
    items = recordOutcomes(items, Object.fromEntries(items.map((i) => [i.id, "deleted" as Outcome])));
    const after = computeReadiness(report, items);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.gates.find((g) => g.id === "derogatories")!.passed).toBe(true);
  });
});
