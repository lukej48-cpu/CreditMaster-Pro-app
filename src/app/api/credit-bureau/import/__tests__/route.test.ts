/**
 * @jest-environment node
 *
 * Tests for POST /api/credit-bureau/import (3-bureau HTML report upload).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const mockValidateFromHeaders = jest.fn();
const mockResolveRoleFromDb = jest.fn();
const mockHasPermission = jest.fn();

jest.mock("@/lib/auth/jwt-validation", () => ({
  jwtValidation: {
    validateFromHeaders: (...args: unknown[]) => mockValidateFromHeaders(...args),
  },
}));
jest.mock("@/lib/auth/resolve-role", () => ({
  resolveRoleFromDb: (...args: unknown[]) => mockResolveRoleFromDb(...args),
}));
jest.mock("@/lib/auth/rbac", () => ({
  rbac: { hasPermission: (...args: unknown[]) => mockHasPermission(...args) },
}));

/* ---------- Supabase mock: records inserts, can fail a given table ---------- */
const inserted: Record<string, unknown[]> = {};
const deleted: string[][] = [];
let failTable: string | null = null;
let idSeq = 0;

jest.mock("@/lib/supabase/service-role", () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => ({
      insert: (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        (inserted[table] ??= []).push(...list);
        const error = failTable === table ? { message: "boom" } : null;
        return {
          select: () => ({
            single: async () => ({ data: error ? null : { id: `rep-${++idSeq}` }, error }),
          }),
          then: (resolve: (v: unknown) => void) => resolve({ error }),
        };
      },
      delete: () => ({
        in: (_col: string, ids: string[]) => ({
          eq: async () => {
            deleted.push(ids);
            return { error: null };
          },
        }),
      }),
    }),
  }),
}));

import { POST } from "../route";

const FIXTURE = readFileSync(
  join(
    __dirname,
    "../../../../../lib/credit-report-import/__tests__/fixtures/identityiq-sample.html",
  ),
  "utf8",
);

function requestWith(file?: File): NextRequest {
  const form = new FormData();
  if (file) form.append("file", file);
  const url = "http://localhost:3000/api/credit-bureau/import";
  return {
    url,
    method: "POST",
    headers: new Headers(),
    nextUrl: new URL(url),
    formData: jest.fn().mockResolvedValue(form),
  } as unknown as NextRequest;
}

describe("POST /api/credit-bureau/import", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(inserted)) delete inserted[k];
    deleted.length = 0;
    failTable = null;
    mockValidateFromHeaders.mockResolvedValue({
      valid: true,
      user: { id: "user-1", email: "u@example.com" },
    });
    mockResolveRoleFromDb.mockResolvedValue("user");
    mockHasPermission.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockValidateFromHeaders.mockResolvedValue({ valid: false, user: null });
    const res = await POST(requestWith(new File([FIXTURE], "r.html")));
    expect(res.status).toBe(401);
  });

  it("rejects a missing file", async () => {
    const res = await POST(requestWith());
    expect(res.status).toBe(400);
  });

  it("rejects PDFs with instructions to save as HTML", async () => {
    const res = await POST(
      requestWith(new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Save Page As/);
  });

  it("returns 422 for an HTML file that isn't a 3-bureau report", async () => {
    const res = await POST(requestWith(new File(["<html>login</html>"], "x.html")));
    expect(res.status).toBe(422);
  });

  it("imports all three bureaus from one file (no MIME type needed)", async () => {
    const res = await POST(requestWith(new File([FIXTURE], "client-report.html")));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(Object.keys(body.reportIds)).toEqual(["transunion", "experian", "equifax"]);
    expect(body.accountsCount).toBe(5);
    expect(body.summary.scores).toEqual({ transunion: 612, experian: 598, equifax: 605 });
    expect(body.discrepancies.length).toBeGreaterThan(5);

    expect(inserted.credit_reports).toHaveLength(3);
    expect(inserted.credit_accounts).toHaveLength(5 + 3 + 4);
    // Every child row is tied to its report and the authenticated user.
    for (const row of inserted.credit_accounts as Array<Record<string, unknown>>) {
      expect(row.user_id).toBe("user-1");
      expect(String(row.report_id)).toMatch(/^rep-/);
    }
    // PII: the HTML itself and the full SSN are never stored.
    const stored = JSON.stringify(inserted);
    expect(stored).not.toContain("123-45-6789");
    expect(stored).not.toContain("<table");
  });

  it("rolls back saved reports when a child insert fails", async () => {
    failTable = "credit_accounts";
    const res = await POST(requestWith(new File([FIXTURE], "r.html")));
    expect(res.status).toBe(500);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toHaveLength(1);
  });
});
