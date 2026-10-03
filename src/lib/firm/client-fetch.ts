"use client";

/**
 * fetch() for the staff screens. API routes authenticate with a Bearer token
 * (see lib/auth/api-guard), so attach the signed-in user's Supabase access
 * token to every request.
 */

import { createClient } from "@/lib/supabase/client";

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  return fetch(input, { ...init, headers });
}
