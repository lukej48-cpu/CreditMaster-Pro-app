/**
 * POST /api/firm/clients/[id]/report (multipart, field "file")
 * Upload the client's 3-bureau report saved as HTML. Replaces the case's
 * report and leads; refused once a round has been mailed for this report,
 * so an in-flight dispute history is never wiped by accident.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRole } from "@/lib/auth/api-guard";
import type { AuthedUser } from "@/lib/auth/api-guard";
import { CaseError, caseFromUpload } from "@/lib/firm/case-service";
import { clientIdFromPath, errorResponse, loadCase, loadClient, saveCase } from "@/lib/firm/store";

export const runtime = "nodejs";
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = withRole("admin", async (req: NextRequest, user: AuthedUser) => {
  try {
    const id = clientIdFromPath(req.nextUrl.pathname);
    await loadClient(user.id, id);
    const existing = await loadCase(user.id, id);
    const replace = req.nextUrl.searchParams.get("replace") === "1";
    if (existing?.rounds?.length && !replace) {
      throw new CaseError(
        "Rounds have already been mailed from this client's current report. Re-upload with replace=1 to start a new dispute case.",
        409,
      );
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new CaseError("No file provided.");
    if (file.size === 0 || file.size > MAX_BYTES) throw new CaseError("File must be between 1 byte and 10MB.");
    if (!/\.(html?|mhtml?)$/i.test(file.name) && file.type !== "text/html") {
      throw new CaseError("Upload the report saved as an HTML page (File > Save Page As > Webpage, HTML only).");
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const { summary, ...row } = caseFromUpload(bytes, bytes.toString("utf8"));
    await saveCase(user.id, id, row);
    return NextResponse.json({ success: true, summary, leads: row.leads });
  } catch (err) {
    return errorResponse(err);
  }
});
