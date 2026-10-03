"use client";

/**
 * Upload a 3-bureau report (IdentityIQ / MyScoreIQ / SmartCredit saved as
 * HTML), import all three bureaus at once and show the cross-bureau
 * dispute leads found.
 */

import { useRef, useState } from "react";
import { authFetch } from "@/lib/firm/client-fetch";
import type { Bureau } from "@/types/credit-bureau";
import type { Discrepancy } from "@/lib/credit-report-import/types";
import type { ImportSummary } from "@/lib/credit-report-import/persistence";

interface Props {
  onImportComplete?: (reportId: string) => void;
  onError?: (error: string) => void;
}

interface ImportResult {
  reportId: string;
  summary: ImportSummary;
  discrepancies: Discrepancy[];
}

const BUREAU_LABEL: Record<Bureau, string> = {
  transunion: "TransUnion",
  experian: "Experian",
  equifax: "Equifax",
};

const SEVERITY_STYLE: Record<Discrepancy["severity"], string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};

export default function ThreeBureauReportImport({ onImportComplete, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await authFetch("/api/credit-bureau/import", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || "Import failed");
      setResult({
        reportId: body.reportId,
        summary: body.summary,
        discrepancies: body.discrepancies ?? [],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Import failed";
      setError(msg);
      onError?.(msg);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-slate-700">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
        Import a 3-Bureau Report
      </h2>
      <p className="text-sm text-gray-600 dark:text-slate-300 mb-5">
        TransUnion, Experian and Equifax in one upload, from IdentityIQ, MyScoreIQ or SmartCredit.
      </p>

      {!result && (
        <>
          <ol className="text-sm text-gray-700 dark:text-slate-200 list-decimal pl-5 space-y-1 mb-5">
            <li>Log in to the monitoring site and open the full 3-bureau report.</li>
            <li>
              Press <kbd className="px-1 rounded bg-gray-100 dark:bg-slate-700">Ctrl/⌘ + S</kbd>{" "}
              and choose <strong>Webpage, HTML only</strong> (not PDF).
            </li>
            <li>Upload the saved .html file below.</li>
          </ol>

          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void upload(f);
            }}
            className={`w-full rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              dragging
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                : "border-gray-300 dark:border-slate-600 hover:border-blue-400"
            } ${busy ? "opacity-60 cursor-wait" : ""}`}
          >
            <div className="font-semibold text-gray-900 dark:text-white">
              {busy ? "Reading all three bureaus…" : "Drop the report here or click to choose"}
            </div>
            <div className="text-xs text-gray-500 dark:text-slate-400 mt-1">
              .html / .htm / .mhtml, up to 10MB
            </div>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".html,.htm,.mhtml,.mht,text/html"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </>
      )}

      {error && (
        <div role="alert" className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {result && <Results result={result} onDone={() => onImportComplete?.(result.reportId)} onAnother={() => setResult(null)} />}
    </div>
  );
}

function Results({
  result,
  onDone,
  onAnother,
}: {
  result: ImportResult;
  onDone: () => void;
  onAnother: () => void;
}) {
  const { summary, discrepancies } = result;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {(["transunion", "experian", "equifax"] as Bureau[]).map((b) => (
          <div key={b} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 text-center">
            <div className="text-xs text-gray-500 dark:text-slate-400">{BUREAU_LABEL[b]}</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white tabular-nums">
              {summary.scores[b] ?? "—"}
            </div>
          </div>
        ))}
      </div>

      <div className="text-sm text-gray-700 dark:text-slate-200">
        {summary.accounts} accounts ({summary.negativeAccounts} negative) · {summary.inquiries}{" "}
        inquiries · {summary.publicRecords} public records
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
          Dispute leads: {summary.discrepancies.high} high · {summary.discrepancies.medium} medium ·{" "}
          {summary.discrepancies.low} low
        </h3>
        <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
          Each lead is an inconsistency between bureaus. Confirm an item is inaccurate before disputing it.
        </p>
        <ul className="divide-y divide-gray-100 dark:divide-slate-700 max-h-96 overflow-y-auto">
          {discrepancies.map((d, i) => (
            <li key={i} className="py-2 flex gap-3 items-start">
              <span className={`shrink-0 text-xs font-semibold uppercase px-2 py-0.5 rounded ${SEVERITY_STYLE[d.severity]}`}>
                {d.severity}
              </span>
              <div className="text-sm">
                <div className="text-gray-900 dark:text-white">{d.description}</div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                  Dispute with: {d.bureaus.map((b) => BUREAU_LABEL[b]).join(", ")}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {summary.warnings.length > 0 && (
        <details className="text-xs text-gray-500 dark:text-slate-400">
          <summary>{summary.warnings.length} item(s) could not be fully read</summary>
          <ul className="list-disc pl-5 mt-1">
            {summary.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onDone}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
        >
          View reports
        </button>
        <button
          type="button"
          onClick={onAnother}
          className="px-4 py-2 rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-slate-200"
        >
          Import another
        </button>
      </div>
    </div>
  );
}
