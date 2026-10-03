/**
 * GET  /api/firm/clients — the staff member's client list
 * POST /api/firm/clients — add a client { fullName, addressLines[], state, email?, phone? }
 *
 * Staff accounts are users with the admin role.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRole } from "@/lib/auth/api-guard";
import type { AuthedUser } from "@/lib/auth/api-guard";
import { getServiceRoleClient } from "@/lib/supabase/service-role";
import { CaseError } from "@/lib/firm/case-service";
import { errorResponse } from "@/lib/firm/store";

export const GET = withRole("admin", async (_req: NextRequest, user: AuthedUser) => {
  const { data, error } = await getServiceRoleClient()
    .from("firm_clients")
    .select("id, full_name, state, email, phone, created_at")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return errorResponse(new CaseError("Could not load clients.", 500));
  return NextResponse.json({ success: true, clients: data ?? [] });
});

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

export const POST = withRole("admin", async (req: NextRequest, user: AuthedUser) => {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const fullName = str(body.fullName, 200);
    const addressLines = Array.isArray(body.addressLines)
      ? body.addressLines.map((l) => str(l, 120)).filter((l): l is string => Boolean(l)).slice(0, 4)
      : [];
    const state = str(body.state, 2)?.toUpperCase();
    if (!fullName) throw new CaseError("Client name is required.");
    if (!addressLines.length) throw new CaseError("Client mailing address is required.");
    if (!state || !/^[A-Z]{2}$/.test(state)) throw new CaseError("Two-letter state is required.");

    const { data, error } = await getServiceRoleClient()
      .from("firm_clients")
      .insert({
        owner_id: user.id,
        full_name: fullName,
        address_lines: addressLines,
        state,
        email: str(body.email, 200) ?? null,
        phone: str(body.phone, 40) ?? null,
      })
      .select("id")
      .single();
    if (error || !data) throw new CaseError("Could not create client.", 500);
    return NextResponse.json({ success: true, id: data.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
});
