-- ============================================================================
-- FUNDED UP firm workflow: staff-managed client files and dispute cases.
--
-- firm_clients        one row per credit client, owned by the staff user
--                     (admin role) who manages the file.
-- firm_dispute_cases  one active case per client: the latest parsed
--                     3-bureau report, analyzer leads, dispute items with
--                     their per-round outcomes, and a log of rounds mailed.
--
-- Uploaded report HTML is never stored (PII); only the parsed data and a
-- SHA-256 of the file. No full SSN is ever stored — the parser redacts it.
-- API routes use the service role and always filter by owner_id; RLS below
-- protects direct client access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS firm_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  address_lines TEXT[] NOT NULL DEFAULT '{}',
  state CHAR(2),
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_firm_clients_owner ON firm_clients(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS firm_dispute_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL UNIQUE REFERENCES firm_clients(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report JSONB,              -- TriBureauReport (dates as ISO strings)
  report_sha256 TEXT,
  leads JSONB NOT NULL DEFAULT '[]',   -- Discrepancy[] with lead ids
  items JSONB NOT NULL DEFAULT '[]',   -- DisputeItem[] (outcomes per round)
  rounds JSONB NOT NULL DEFAULT '[]',  -- [{round, mailedOn, letters, itemIds}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_firm_dispute_cases_owner ON firm_dispute_cases(owner_id);

ALTER TABLE firm_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_dispute_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff manage own clients" ON firm_clients;
CREATE POLICY "Staff manage own clients" ON firm_clients
  FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS "Staff manage own dispute cases" ON firm_dispute_cases;
CREATE POLICY "Staff manage own dispute cases" ON firm_dispute_cases
  FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
