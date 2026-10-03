"use client";

/**
 * FUNDED UP staff: client list + add client.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

interface ClientRow {
  id: string;
  full_name: string;
  state: string | null;
  email: string | null;
  created_at: string;
}

const input =
  "w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-gray-900 dark:text-white";

export default function FirmClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: "", street: "", cityStateZip: "", state: "", email: "", phone: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/firm/clients");
    const body = await res.json().catch(() => ({}));
    if (res.ok) setClients(body.clients ?? []);
    else setError(body.error || body.message || "Could not load clients.");
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/firm/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: form.fullName,
        addressLines: [form.street, form.cityStateZip],
        state: form.state,
        email: form.email,
        phone: form.phone,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) return setError(body.error || "Could not add client.");
    window.location.href = `/admin/clients/${body.id}`;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Credit Clients</h1>
        <p className="text-sm text-gray-600 dark:text-slate-300">
          Upload each client&apos;s 3-bureau report and generate their dispute package.
        </p>
      </div>

      <form onSubmit={create} className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 grid gap-3 md:grid-cols-2">
        <h2 className="md:col-span-2 font-semibold text-gray-900 dark:text-white">Add client</h2>
        <input className={input} placeholder="Full legal name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
        <input className={input} placeholder="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className={input} placeholder="Street address" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} required />
        <input className={input} placeholder="City, ST ZIP" value={form.cityStateZip} onChange={(e) => setForm({ ...form, cityStateZip: e.target.value })} required />
        <input className={input} placeholder="State (e.g. NJ)" maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} required />
        <input className={input} placeholder="Phone (optional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <div className="md:col-span-2">
          <button disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? "Adding…" : "Add client"}
          </button>
        </div>
      </form>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 divide-y divide-gray-100 dark:divide-slate-700">
        {loading && <div className="p-4 text-sm text-gray-500">Loading…</div>}
        {!loading && clients.length === 0 && <div className="p-4 text-sm text-gray-500">No clients yet.</div>}
        {clients.map((c) => (
          <Link key={c.id} href={`/admin/clients/${c.id}`} className="flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-slate-700/50">
            <div>
              <div className="font-medium text-gray-900 dark:text-white">{c.full_name}</div>
              <div className="text-xs text-gray-500 dark:text-slate-400">{[c.state, c.email].filter(Boolean).join(" · ")}</div>
            </div>
            <span className="text-sm text-blue-600">Open file →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
