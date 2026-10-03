/**
 * 3-Bureau Report Import API
 *
 * POST /api/credit-bureau/import  (multipart/form-data)
 *   file: the full report page saved as HTML from IdentityIQ, MyScoreIQ or
 *         SmartCredit (any layout with TransUnion / Experian / Equifax columns)
 *
 * Parses all three bureaus from the one file, runs the cross-bureau
 * analyzer, and stores one credit_reports row per bureau (plus accounts,
 * inquiries and public records). The uploaded HTML itself is NOT stored —
 * only a SHA-256 hash — because it contains the consumer's PII.
 *
 * Response: { success, importId, reportIds, summary, discrepancies }
 */

import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withPermission } from "@/lib/auth/api-guard";
import type { AuthedUser } from "@/lib/auth/api-guard";
import { getServiceRoleClient } from "@/lib/supabase/service-role";
import {
  analyzeCrossBureau,
  parseThreeBureauHtml,
  ReportParseError,
  summarizeImport,
  toBureauSlices,
} from "@/lib/credit-report-import";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const HTML_EXT = /\.(html?|mhtml?)$/i;

export const POST = withPermission(
  "credit:read",
  async (request: NextRequest, user: AuthedUser) => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return badRequest("Expected a multipart form upload with a 'file' field.");
    }

    const file = form.get("file");
    if (!(file instanceof File)) return badRequest("No file provided.");
    if (file.size === 0) return badRequest("The file is empty.");
    if (file.size > MAX_BYTES) return badRequest("File size exceeds 10MB limit.");

    // Browsers often send "" or application/octet-stream for saved pages,
    // so accept by extension as well as MIME type.
    const isHtml =
      HTML_EXT.test(file.name) ||
      ["text/html", "application/xhtml+xml", "multipart/related"].includes(file.type);
    if (!isHtml) {
      return badRequest(
        file.type === "application/pdf" || /\.pdf$/i.test(file.name)
          ? "PDF reports lose their table layout and can't be read reliably. Open the report in your browser and use File → Save Page As → 'Webpage, HTML only', then upload that file."
          : "Unsupported file type. Upload the report saved as an HTML page.",
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const html = decodeHtml(bytes, file.name);
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");

    let report;
    try {
      report = parseThreeBureauHtml(html);
    } catch (err) {
      if (err instanceof ReportParseError) return badRequest(err.message, 422);
      return serverError("Could not read the report file.");
    }

    const discrepancies = analyzeCrossBureau(report);
    const importId = randomUUID();
    const slices = toBureauSlices(report, discrepancies, {
      userId: user.id,
      importId,
      fileName: file.name.slice(0, 200),
      fileSha256,
      today: new Date(),
    });

    const supabase = getServiceRoleClient();
    const reportIds: Partial<Record<string, string>> = {};

    try {
      for (const slice of slices) {
        const { data: row, error } = await supabase
          .from("credit_reports")
          .insert(slice.report)
          .select("id")
          .single();
        if (error || !row) throw new Error(`credit_reports: ${error?.message}`);
        reportIds[slice.bureau] = row.id;

        const withReport = <T extends Record<string, unknown>>(rows: T[]) =>
          rows.map((r) => ({ ...r, report_id: row.id }));

        const inserts: Array<[string, Array<Record<string, unknown>>]> = [
          ["credit_accounts", withReport(slice.accounts)],
          ["credit_inquiries", withReport(slice.inquiries)],
          ["public_records", withReport(slice.publicRecords)],
        ];
        for (const [table, rows] of inserts) {
          if (rows.length === 0) continue;
          const { error: e } = await supabase.from(table).insert(rows);
          if (e) throw new Error(`${table}: ${e.message}`);
        }
      }
    } catch (err) {
      // Roll back: child rows cascade from credit_reports.
      const ids = Object.values(reportIds).filter(Boolean) as string[];
      if (ids.length) {
        await supabase.from("credit_reports").delete().in("id", ids).eq("user_id", user.id);
      }
      return serverError(
        "The report was read but could not be saved. Please try again.",
        err instanceof Error ? err.message : undefined,
      );
    }

    const summary = summarizeImport(report, discrepancies);
    return NextResponse.json({
      success: true,
      importId,
      reportIds,
      // Kept for the existing CreditReportImport component.
      reportId: Object.values(reportIds)[0],
      accountsCount: summary.accounts,
      summary,
      discrepancies,
    });
  },
);

/**
 * Saved pages are usually UTF-8, but some browsers save as windows-1252.
 * "Save as complete webpage (single file)" on Chrome produces MHTML, whose
 * HTML part is quoted-printable encoded.
 */
function decodeHtml(bytes: Buffer, name: string): string {
  let text = bytes.toString("utf8");
  if (text.includes("�")) text = new TextDecoder("windows-1252").decode(bytes);
  if (/\.mhtml?$/i.test(name) || /^MIME-Version:/im.test(text.slice(0, 2000))) {
    // Decode quoted-printable to bytes first, then UTF-8, so multi-byte
    // characters (accented names, ®) survive.
    const unfolded = text.replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (unfolded[i] === "=" && /^[0-9A-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else {
        const code = unfolded.charCodeAt(i);
        if (code < 0x80) out.push(code);
        else out.push(...Buffer.from(unfolded[i], "utf8"));
      }
    }
    text = Buffer.from(out).toString("utf8");
  }
  return text;
}

function badRequest(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

function serverError(error: string, detail?: string) {
  // Detail goes to logs only — it can contain table/constraint names.
  if (detail) console.error("[credit-bureau/import]", detail);
  return NextResponse.json({ success: false, error }, { status: 500 });
}
