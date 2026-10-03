/**
 * GET /api/firm/clients/[id] — client, report summary, leads (with ids),
 * dispute items, rounds mailed, next round and funding readiness.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRole } from "@/lib/auth/api-guard";
import type { AuthedUser } from "@/lib/auth/api-guard";
import { caseView } from "@/lib/firm/case-service";
import { clientIdFromPath, errorResponse, loadCase, loadClient } from "@/lib/firm/store";

export const GET = withRole("admin", async (req: NextRequest, user: AuthedUser) => {
  try {
    const id = clientIdFromPath(req.nextUrl.pathname);
    const client = await loadClient(user.id, id);
    const row = await loadCase(user.id, id);
    return NextResponse.json({ success: true, client, case: caseView(row) });
  } catch (err) {
    return errorResponse(err);
  }
});
