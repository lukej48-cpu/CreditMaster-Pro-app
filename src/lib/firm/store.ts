/**
 * Storage for firm clients and dispute cases. Every query is scoped to the
 * staff owner (service-role client, so the owner filter is the IDOR guard).
 */

import { NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabase/service-role";
import { CaseError, type CaseRow, type FirmClient } from "./case-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /api/firm/clients/{id}/... → id */
export function clientIdFromPath(pathname: string): string {
  const id = pathname.split("/")[4] ?? "";
  if (!UUID.test(id)) throw new CaseError("Invalid client id.", 400);
  return id;
}

export async function loadClient(ownerId: string, clientId: string): Promise<FirmClient> {
  const { data, error } = await getServiceRoleClient()
    .from("firm_clients")
    .select("*")
    .eq("id", clientId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new CaseError("Could not load client.", 500);
  if (!data) throw new CaseError("Client not found.", 404);
  return data as FirmClient;
}

export async function loadCase(ownerId: string, clientId: string): Promise<CaseRow | null> {
  const { data, error } = await getServiceRoleClient()
    .from("firm_dispute_cases")
    .select("client_id, owner_id, report, report_sha256, leads, items, rounds")
    .eq("client_id", clientId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new CaseError("Could not load the dispute case.", 500);
  return (data as CaseRow) ?? null;
}

export async function saveCase(ownerId: string, clientId: string, patch: Partial<CaseRow>): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from("firm_dispute_cases")
    .upsert(
      { client_id: clientId, owner_id: ownerId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "client_id" },
    );
  if (error) throw new CaseError("Could not save the dispute case.", 500);
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof CaseError) {
    return NextResponse.json({ success: false, error: err.message }, { status: err.status });
  }
  // ReportParseError and other parser messages are user-facing.
  if (err instanceof Error && err.name === "ReportParseError") {
    return NextResponse.json({ success: false, error: err.message }, { status: 422 });
  }
  console.error("[firm]", err instanceof Error ? err.message : err);
  return NextResponse.json({ success: false, error: "Something went wrong." }, { status: 500 });
}
