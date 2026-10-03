/**
 * POST /api/firm/clients/[id]/package
 * { round: 1|2|3, confirmedLeadIds?: string[], claims?: ClientClaim[], mailDate?: "YYYY-MM-DD" }
 *
 * One button: builds the tailored dispute package for the round (bureau,
 * furnisher and collector letters), records the round, and returns one
 * print-ready PDF.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRole } from "@/lib/auth/api-guard";
import type { AuthedUser } from "@/lib/auth/api-guard";
import { CaseError, generatePackage } from "@/lib/firm/case-service";
import { renderPacketPdf } from "@/lib/dispute-engine/pdf";
import type { ClientClaim, Round } from "@/lib/dispute-engine";
import { clientIdFromPath, errorResponse, loadCase, loadClient, saveCase } from "@/lib/firm/store";

export const runtime = "nodejs";

const CLAIM_REASONS = new Set([
  "not_mine", "identity_theft", "never_late", "paid_in_full",
  "unauthorized_inquiry", "never_lived_at_address", "never_used_name",
]);
const BUREAUS = new Set(["transunion", "experian", "equifax"]);
const KINDS = new Set(["account", "inquiry", "personal", "public_record"]);

function parseClaims(v: unknown): ClientClaim[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 100) throw new CaseError("claims must be a list.");
  return v.map((c) => {
    const x = c as Record<string, unknown>;
    const bureaus = Array.isArray(x.bureaus) ? x.bureaus.filter((b) => BUREAUS.has(b as string)) : [];
    if (!KINDS.has(x.kind as string) || !CLAIM_REASONS.has(x.reason as string) || !bureaus.length || typeof x.subject !== "string") {
      throw new CaseError("Invalid client claim.");
    }
    return {
      kind: x.kind,
      bureaus,
      subject: (x.subject as string).slice(0, 200),
      reason: x.reason,
      correctValue: typeof x.correctValue === "string" ? x.correctValue.slice(0, 200) : undefined,
    } as ClientClaim;
  });
}

export const POST = withRole("admin", async (req: NextRequest, user: AuthedUser) => {
  try {
    const id = clientIdFromPath(req.nextUrl.pathname);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const round = Number(body.round);
    if (![1, 2, 3].includes(round)) throw new CaseError("round must be 1, 2 or 3.");
    const confirmedLeadIds = Array.isArray(body.confirmedLeadIds)
      ? body.confirmedLeadIds.filter((x): x is string => typeof x === "string")
      : [];
    const date =
      typeof body.mailDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.mailDate)
        ? new Date(`${body.mailDate}T00:00:00Z`)
        : new Date();

    const client = await loadClient(user.id, id);
    const row = await loadCase(user.id, id);
    if (!row) throw new CaseError("Upload the client's 3-bureau report first.");

    const result = generatePackage(row, client, {
      round: round as Round,
      confirmedLeadIds,
      claims: parseClaims(body.claims),
      date,
    });
    const pdf = await renderPacketPdf(result.plan, { clientName: client.full_name, timeline: result.timeline });
    await saveCase(user.id, id, { items: result.items, rounds: result.rounds });

    const fileName = `${client.full_name.replace(/[^A-Za-z0-9]+/g, "_")}_Round${round}_${result.timeline.mailedOn}.pdf`;
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Letters": String(result.plan.letters.length),
        "X-Needs-Address": String(result.plan.letters.filter((l) => l.recipient.addressLines.length === 0).length),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
