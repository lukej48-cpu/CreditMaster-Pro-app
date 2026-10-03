/**
 * POST /api/firm/clients/[id]/outcomes
 * { results: { [itemId]: "deleted"|"updated"|"verified"|"no_response" }, responseDate?: "MM/DD/YYYY" }
 *
 * Records the bureau's results for the round in flight. Readiness for
 * underwriting is recomputed from these on every read.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRole } from "@/lib/auth/api-guard";
import type { AuthedUser } from "@/lib/auth/api-guard";
import { CaseError, applyOutcomes, caseView } from "@/lib/firm/case-service";
import { clientIdFromPath, errorResponse, loadCase, loadClient, saveCase } from "@/lib/firm/store";

export const POST = withRole("admin", async (req: NextRequest, user: AuthedUser) => {
  try {
    const id = clientIdFromPath(req.nextUrl.pathname);
    await loadClient(user.id, id);
    const row = await loadCase(user.id, id);
    if (!row) throw new CaseError("No dispute case for this client yet.", 404);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body.results || typeof body.results !== "object") throw new CaseError("results is required.");
    const items = applyOutcomes(
      row,
      body.results as Record<string, string>,
      typeof body.responseDate === "string" ? body.responseDate : undefined,
    );
    await saveCase(user.id, id, { items });
    return NextResponse.json({ success: true, case: caseView({ ...row, items }) });
  } catch (err) {
    return errorResponse(err);
  }
});
