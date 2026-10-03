"use client";

/**
 * FUNDED UP staff: one client's credit file.
 * 1. Upload the 3-bureau report  2. Confirm items with the client
 * 3. Generate the round's package (one PDF)  4. Record bureau results
 * Readiness for underwriting updates as items are deleted.
 */

import Link from "next/link";
import { authFetch } from "@/lib/firm/client-fetch";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Bureau = "transunion" | "experian" | "equifax";
const BUREAU: Record<Bureau, string> = { transunion: "TransUnion", experian: "Experian", equifax: "Equifax" };

interface Lead {
  id: string;
  type: string;
  severity: "high" | "medium" | "low";
  bureaus: Bureau[];
  creditorName?: string;
  description: string;
}
interface Item {
  id: string;
  name: string;
  bureau: Bureau;
  kind: string;
  reasons: string[];
  outcomes: string[];
}
interface Gate {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}
interface CaseView {
  hasReport: boolean;
  summary: null | {
    reportDate: string | null;
    scores: Partial<Record<Bureau, number>>;
    accounts: number;
    negativeAccounts: number;
    inquiries: number;
  };
  leads: Lead[];
  items: Item[];
  rounds: Array<{ round: number; mailedOn: string; recipients: string[] }>;
  nextRound: number | null;
  readiness: null | { score: number; ready: boolean; gates: Gate[]; nextActions: string[] };
  escalate: string[];
}
interface Client {
  id: string;
  full_name: string;
  address_lines: string[];
  state: string | null;
}

const card = "rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5";
const sevStyle = {
  high: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};
const OUTCOME_LABEL: Record<string, string> = {
  pending: "Awaiting response",
  deleted: "Deleted",
  updated: "Updated",
  verified: "Verified",
  no_response: "No response",
};

export default function ClientFilePage() {
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [mailDate, setMailDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [results, setResults] = useState<Record<string, string>>({});
  const [responseDate, setResponseDate] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await authFetch(`/api/firm/clients/${id}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error || body.message || "Could not load client.");
    setClient(body.client);
    setView(body.case);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(() => (view?.items ?? []).filter((i) => i.outcomes.at(-1) === "pending"), [view]);

  async function upload(file: File, replace = false) {
    setBusy("upload");
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await authFetch(`/api/firm/clients/${id}/report${replace ? "?replace=1" : ""}`, { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) return setError(body.error || "Upload failed.");
    setConfirmed(new Set());
    setNotice(`Report imported: ${body.summary.accounts} accounts, ${body.summary.discrepancies.total} leads.`);
    await load();
  }

  async function generate() {
    if (!view?.nextRound) return;
    setBusy("generate");
    setError(null);
    const res = await authFetch(`/api/firm/clients/${id}/package`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ round: view.nextRound, confirmedLeadIds: [...confirmed], mailDate }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setError(body.error || "Could not generate the package.");
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "dispute-package.pdf";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    const needs = Number(res.headers.get("X-Needs-Address") ?? 0);
    setNotice(
      `Round ${view.nextRound} package downloaded: ${res.headers.get("X-Letters")} letters.` +
        (needs ? ` ${needs} creditor/collector letter(s) need a mailing address added before mailing.` : ""),
    );
    await load();
  }

  async function saveResults() {
    setBusy("results");
    setError(null);
    const res = await authFetch(`/api/firm/clients/${id}/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results, responseDate: responseDate || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setError(body.error || "Could not save results.");
    setResults({});
    setView(body.case);
    setNotice("Results saved. Readiness updated.");
  }

  if (!client || !view) {
    return <div className="p-6 text-sm text-gray-500">{error ?? "Loading…"}</div>;
  }

  const round1 = view.nextRound === 1;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/clients" className="text-sm text-blue-600">← All clients</Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{client.full_name}</h1>
        <p className="text-sm text-gray-600 dark:text-slate-300">{client.address_lines.join(", ")}</p>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</div>}

      {/* 1. Report */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 dark:text-white">1. 3-bureau report</h2>
          <button
            disabled={busy === "upload"}
            onClick={() => fileRef.current?.click()}
            className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm"
          >
            {busy === "upload" ? "Reading…" : view.hasReport ? "Upload newer report" : "Upload report (.html)"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".html,.htm,.mhtml,.mht,text/html"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const replace = view.rounds.length > 0;
              if (replace && !window.confirm("Rounds were already mailed from the current report. Start a new dispute case from this report?")) return;
              void upload(f, replace);
            }}
          />
        </div>
        {view.summary && (
          <div className="mt-4 grid grid-cols-3 gap-3">
            {(["transunion", "experian", "equifax"] as Bureau[]).map((b) => (
              <div key={b} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 text-center">
                <div className="text-xs text-gray-500">{BUREAU[b]}</div>
                <div className="text-2xl font-bold tabular-nums text-gray-900 dark:text-white">{view.summary!.scores[b] ?? "—"}</div>
              </div>
            ))}
            <div className="col-span-3 text-sm text-gray-600 dark:text-slate-300">
              {view.summary.accounts} accounts ({view.summary.negativeAccounts} negative) · {view.summary.inquiries} inquiries
              {view.summary.reportDate ? ` · report dated ${view.summary.reportDate}` : ""}
            </div>
          </div>
        )}
      </section>

      {/* 2. Confirm items (Round 1 only) */}
      {view.hasReport && round1 && (
        <section className={card}>
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold text-gray-900 dark:text-white">2. Confirm items with the client</h2>
            <button
              className="text-sm text-blue-600"
              onClick={() => setConfirmed(new Set(view.leads.filter((l) => l.severity !== "low").map((l) => l.id)))}
            >
              Select high + medium
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
            Tick only items the client confirms are inaccurate, incomplete or unauthorized. Unticked leads are never disputed.
          </p>
          <ul className="divide-y divide-gray-100 dark:divide-slate-700">
            {view.leads.map((l) => (
              <li key={l.id} className="py-2">
                <label className="flex gap-3 items-start cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmed.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(confirmed);
                      if (e.target.checked) next.add(l.id);
                      else next.delete(l.id);
                      setConfirmed(next);
                    }}
                  />
                  <span className={`shrink-0 text-xs font-semibold uppercase px-2 py-0.5 rounded ${sevStyle[l.severity]}`}>{l.severity}</span>
                  <span className="text-sm text-gray-900 dark:text-white">
                    {l.description}
                    <span className="block text-xs text-gray-500">Dispute with: {l.bureaus.map((b) => BUREAU[b]).join(", ")}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 3. Generate */}
      {view.hasReport && (
        <section className={card}>
          <h2 className="font-semibold text-gray-900 dark:text-white">
            {view.nextRound ? `3. Generate Round ${view.nextRound} package` : "3. Dispute package"}
          </h2>
          {view.nextRound ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm text-gray-700 dark:text-slate-200">
                Mail date
                <input type="date" value={mailDate} onChange={(e) => setMailDate(e.target.value)} className="block mt-1 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm" />
              </label>
              <button
                disabled={busy === "generate" || (round1 && confirmed.size === 0)}
                onClick={() => void generate()}
                className="px-5 py-2.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {busy === "generate" ? "Building package…" : `Generate Round ${view.nextRound} package (PDF)`}
              </button>
              {round1 && <span className="text-xs text-gray-500">{confirmed.size} item(s) confirmed</span>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
              {view.rounds.length >= 3
                ? "All three rounds mailed. Items still verified go to CFPB complaint and attorney review."
                : "Record the bureau results below to unlock the next round."}
            </p>
          )}
          {view.rounds.length > 0 && (
            <ul className="mt-4 text-xs text-gray-500 dark:text-slate-400 space-y-1">
              {view.rounds.map((r) => (
                <li key={r.round}>Round {r.round} mailed {r.mailedOn}: {r.recipients.join(", ")}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 4. Results */}
      {view.items.length > 0 && (
        <section className={card}>
          <h2 className="font-semibold text-gray-900 dark:text-white">4. Bureau results</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1">Item</th>
                <th>Bureau</th>
                <th>History</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {view.items.map((i) => (
                <tr key={i.id}>
                  <td className="py-2 text-gray-900 dark:text-white">{i.name}</td>
                  <td>{BUREAU[i.bureau]}</td>
                  <td className="text-xs text-gray-500">
                    {i.outcomes.map((o, k) => `R${k + 1}: ${OUTCOME_LABEL[o] ?? o}`).join(" · ") || "Not disputed"}
                    {view.escalate.includes(i.id) && <span className="ml-2 text-red-600 font-semibold">Escalate</span>}
                  </td>
                  <td>
                    {i.outcomes.at(-1) === "pending" ? (
                      <select
                        value={results[i.id] ?? ""}
                        onChange={(e) => setResults({ ...results, [i.id]: e.target.value })}
                        className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
                      >
                        <option value="">—</option>
                        <option value="deleted">Deleted</option>
                        <option value="updated">Updated</option>
                        <option value="verified">Verified</option>
                        <option value="no_response">No response</option>
                      </select>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pending.length > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm text-gray-700 dark:text-slate-200">
                Bureau response date (MM/DD/YYYY)
                <input value={responseDate} onChange={(e) => setResponseDate(e.target.value)} placeholder="11/06/2026" className="block mt-1 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm" />
              </label>
              <button
                disabled={busy === "results" || Object.keys(results).length === 0}
                onClick={() => void saveResults()}
                className="px-4 py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium disabled:opacity-50"
              >
                Save results
              </button>
            </div>
          )}
        </section>
      )}

      {/* Readiness */}
      {view.readiness && (
        <section className={card}>
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold text-gray-900 dark:text-white">Funding readiness</h2>
            <span className={`text-sm font-semibold ${view.readiness.ready ? "text-green-600" : "text-amber-600"}`}>
              {view.readiness.ready ? "Ready for underwriting" : "Not ready yet"}
            </span>
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums text-gray-900 dark:text-white">{view.readiness.score}<span className="text-base text-gray-500">/100</span></div>
          <ul className="mt-3 space-y-1 text-sm">
            {view.readiness.gates.map((g) => (
              <li key={g.id} className={g.passed ? "text-green-700 dark:text-green-400" : "text-gray-700 dark:text-slate-200"}>
                {g.passed ? "✓" : "✗"} {g.label} <span className="text-xs text-gray-500">({g.detail})</span>
              </li>
            ))}
          </ul>
          {view.readiness.nextActions.length > 0 && (
            <div className="mt-3 text-sm text-gray-600 dark:text-slate-300">
              <div className="font-medium">Next actions</div>
              <ul className="list-disc pl-5">
                {view.readiness.nextActions.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
