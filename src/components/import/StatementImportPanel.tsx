"use client";

/**
 * Phase 30.3 — statement/screenshot import UI.
 *
 * Two explicit steps: Preview (never writes a Trade/Transaction) then Commit.
 * The user sees every parsed row, the reason for each invalid row and any
 * duplicates before approving. Only server actions are called here; no
 * provider keys or Prisma code reach the browser.
 */
import { useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  commitStatementImportAction,
  previewStatementImportAction,
  type StatementPreviewResult,
} from "@/server/actions/statement-import";

type AccountOption = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: string;
  currentBalance: string;
};

type RecentBatch = {
  id: string;
  source: string;
  status: string;
  fileName: string | null;
  committed: number;
  duplicates: number;
  errorSummary: string | null;
  createdAt: string;
};

type Props = {
  accounts: AccountOption[];
  recentBatches: RecentBatch[];
};

const STATUS_STYLES: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-500",
  duplicate: "bg-amber-500/10 text-amber-500",
  error: "bg-red-500/10 text-red-500",
};

export function StatementImportPanel({ accounts, recentBatches }: Props) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [preview, setPreview] = useState<StatementPreviewResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const [busy, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const isTextFormat = file
    ? /pdf|image\//i.test(file.type) || /\.(pdf|png|jpe?g|webp)$/i.test(file.name)
    : false;

  function onPreview() {
    if (!accountId || !file) {
      setMessage("Choose an account and a statement file first.");
      return;
    }
    setMessage(null);
    setCommitted(false);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("tradingAccountId", accountId);
      fd.set("file", file);
      if (ocrText.trim()) fd.set("ocrText", ocrText);
      const res = await previewStatementImportAction(fd);
      setPreview(res);
      setMessage(res.message ?? null);
    });
  }

  function onCommit() {
    if (!preview?.ok || !preview.batchId) return;
    setMessage(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("batchId", preview.batchId!);
      fd.set("tradingAccountId", accountId);
      const res = await commitStatementImportAction(fd);
      setMessage(res.message ?? null);
      if (res.ok) {
        setCommitted(true);
        setPreview((prev) =>
          prev
            ? {
                ...prev,
                rows: prev.rows?.map((r) =>
                  r.status === "ok" ? { ...r, status: "duplicate" } : r,
                ),
                alreadyCommitted: true,
              }
            : prev,
        );
      }
    });
  }

  function reset() {
    setPreview(null);
    setFile(null);
    setOcrText("");
    setMessage(null);
    setCommitted(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  const committable = preview?.rows?.filter((r) => r.status === "ok").length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6" data-testid="import-panel">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FileSpreadsheet className="h-6 w-6" aria-hidden="true" />
          Import statements
        </h1>
        <p className="text-sm text-muted-foreground">
          Upload a broker CSV, PDF or screenshot. Review every row before anything is added to your
          journal — re-uploading the same file never duplicates trades.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-4 sm:p-6" aria-label="Upload">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-medium">Trading account</span>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              data-testid="import-account"
            >
              {accounts.length === 0 && <option value="">No active accounts</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.broker} ({a.currency})
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="font-medium">Statement file</span>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain,application/pdf,image/png,image/jpeg,image/webp"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setMessage(null);
              }}
              data-testid="import-file"
            />
            <span className="block text-xs text-muted-foreground">
              CSV up to 2 MB by default. PDF/images are archived and their text layer or OCR output
              is mapped with AI when configured.
            </span>
          </label>
        </div>

        {isTextFormat && (
          <label className="mt-4 block space-y-2 text-sm">
            <span className="font-medium">Extracted statement text (PDF / image)</span>
            <Textarea
              rows={5}
              value={ocrText}
              onChange={(e) => setOcrText(e.target.value)}
              placeholder="Paste the text copied from the PDF or the OCR output here…"
              data-testid="import-ocr-text"
            />
            <span className="block text-xs text-muted-foreground">
              The AI only maps column names to fields — it never receives your name, email or
              screenshots.
            </span>
          </label>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={onPreview}
            disabled={busy || !file || !accountId}
            data-testid="import-preview-btn"
          >
            {busy && !preview ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Preview rows
          </Button>
          {preview && (
            <Button type="button" variant="outline" onClick={reset} disabled={busy}>
              Choose another file
            </Button>
          )}
        </div>
      </section>

      {message && (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 p-3 text-sm"
          data-testid="import-result"
        >
          {message}
        </p>
      )}

      {preview?.ok && preview.rows && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Preview — {preview.fileName}</h2>
              <p className="text-xs text-muted-foreground">
                {preview.validCount} ready · {preview.duplicateCount} duplicate ·{" "}
                {preview.errorCount} invalid · column mapping: {preview.mappingSource}
              </p>
            </div>
            <Button
              type="button"
              onClick={onCommit}
              disabled={busy || committable === 0 || committed || preview.alreadyCommitted}
              data-testid="import-commit-btn"
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {preview.alreadyCommitted || committed
                ? "Already imported"
                : `Commit ${committable} row${committable === 1 ? "" : "s"}`}
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Amount</th>
                  <th className="py-2 pr-3">Asset</th>
                  <th className="py-2 pr-3">Result</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr
                    key={`${row.rowNumber}-${row.externalId || "error"}`}
                    className="border-b border-border/60"
                    data-testid="import-preview-row"
                  >
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                      {row.rowNumber}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{row.date}</td>
                    <td className="py-2 pr-3">{row.type}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.amount}</td>
                    <td className="py-2 pr-3">{row.asset ?? "—"}</td>
                    <td className="py-2 pr-3">{row.result ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[row.status] ?? ""}`}
                      >
                        {row.status === "ok"
                          ? "Ready"
                          : row.status === "duplicate"
                            ? "Duplicate"
                            : (row.error ?? "Invalid")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {committed && (
            <p className="text-sm text-emerald-500">
              Rows committed. Balances and the equity walk were recomputed atomically.
            </p>
          )}
        </section>
      )}

      {recentBatches.length > 0 && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-4 sm:p-6">
          <h2 className="font-semibold">Recent imports</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">File</th>
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Committed</th>
                  <th className="py-2 pr-3">Duplicates</th>
                  <th className="py-2 pr-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {recentBatches.map((b) => (
                  <tr
                    key={b.id}
                    className="border-b border-border/60"
                    data-testid="import-batch-row"
                  >
                    <td className="py-2 pr-3">{b.fileName ?? "—"}</td>
                    <td className="py-2 pr-3">{b.source}</td>
                    <td className="py-2 pr-3">{b.status}</td>
                    <td className="py-2 pr-3 tabular-nums">{b.committed}</td>
                    <td className="py-2 pr-3 tabular-nums">{b.duplicates}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {new Date(b.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer
        className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-500"
        data-testid="import-disclaimer"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Trading binary options involves substantial risk. Imported data is for journaling and
          self-review only — it is not financial advice and past results do not guarantee future
          outcomes. Always verify imported rows against your broker statement before relying on
          them.
        </span>
      </footer>
    </div>
  );
}
