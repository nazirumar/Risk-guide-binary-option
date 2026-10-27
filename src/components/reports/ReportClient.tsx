"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EquityCurveChart } from "@/components/analytics/Charts";
import { StatCard } from "@/components/trader/StatCard";
import { MoneyText } from "@/components/trader/MoneyText";
import { ConfirmDialog } from "@/components/trader/ConfirmDialog";
import { exportTradesCSV, exportTradesXLSX, exportTransactionsCSV } from "@/server/actions/export";
import { exportBackupAction, restoreBackupAction } from "@/server/actions/backup";
import { parseCSVAction, importTradesAction } from "@/server/actions/import";
import { toast } from "@/hooks/use-toast";
import { formatMoney, formatDate, formatPercent } from "@/lib/format";
import {
  Download,
  Upload,
  FileText,
  Printer,
  Database,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Calendar,
} from "lucide-react";

type ReportData = {
  preset: string;
  dateFrom: string;
  dateTo: string;
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    ties: number;
    winRate: number;
    netProfit: number;
    profitFactor: number;
    expectancy: number;
    averageWin: number;
    averageLoss: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    recoveryFactor: number;
    longestWinStreak: number;
    longestLossStreak: number;
    currentStreak: number;
    followedPlanCount: number;
    followedPlanWinRate: number;
    brokePlanCount: number;
    brokePlanWinRate: number;
  };
  equityCurve: { date: string; balance: number }[];
  bestAsset: { key: string; winRate: number; netProfit: number; count: number } | null;
  worstAsset: { key: string; winRate: number; netProfit: number; count: number } | null;
  ruleBreaches: {
    reason: string;
    startedAt: string;
    expiresAt: string | null;
    overriddenAt: string | null;
    overrideReason: string | null;
  }[];
  auditEntries: { action: string; meta: unknown; createdAt: string }[];
  sessionNotes: {
    startedAt: string;
    endedAt: string | null;
    notes: string | null;
    mood: string | null;
  }[];
  journalEntries: { date: string; text: string }[];
  accounts: {
    id: string;
    name: string;
    currency: string;
    type: "DEMO" | "REAL";
    currentBalance: string;
  }[];
  activeAccountId: string | null;
  currency: string;
};

export function ReportClient({ data }: { data: ReportData }) {
  const [showImport, setShowImport] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const router = useRouter();

  return (
    <div className="space-y-6">
      {/* Header + actions */}
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            {data.preset.charAt(0).toUpperCase() + data.preset.slice(1)} report ·{" "}
            {formatDate(data.dateFrom)} → {formatDate(data.dateTo)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="size-4 mr-1.5" aria-hidden="true" />
            Print / PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const res = await exportTradesCSV(data.activeAccountId);
              downloadFile(res.csv, res.filename, "text/csv");
              toast({ title: "CSV exported", description: res.filename });
            }}
          >
            <Download className="size-4 mr-1.5" aria-hidden="true" />
            Trades CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const res = await exportTradesXLSX(data.activeAccountId);
              downloadFile(
                res.buffer,
                res.filename,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              );
              toast({ title: "XLSX exported", description: res.filename });
            }}
          >
            <Download className="size-4 mr-1.5" aria-hidden="true" />
            Trades XLSX
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const res = await exportTransactionsCSV(data.activeAccountId);
              downloadFile(res.csv, res.filename, "text/csv");
              toast({ title: "Transactions CSV exported", description: res.filename });
            }}
          >
            <Download className="size-4 mr-1.5" aria-hidden="true" />
            Transactions CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(!showImport)}>
            <Upload className="size-4 mr-1.5" aria-hidden="true" />
            Import CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowBackup(!showBackup)}>
            <Database className="size-4 mr-1.5" aria-hidden="true" />
            Backup
          </Button>
        </div>
      </div>

      {/* Date range presets */}
      <div className="flex gap-2 print:hidden">
        {(["daily", "weekly", "monthly"] as const).map((p) => (
          <a
            key={p}
            href={`/app/reports?preset=${p}`}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${data.preset === p ? "bg-primary text-primary-foreground" : "border border-input hover:bg-accent"}`}
          >
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </a>
        ))}
        <a
          href="/app/analytics"
          className="px-3 py-1.5 rounded-md text-sm font-medium border border-input hover:bg-accent"
        >
          Custom range →
        </a>
      </div>

      {/* Summary stats */}
      <Card className="p-5 print:border-0 print:shadow-none">
        <h2 className="text-base font-semibold mb-3">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard
            label="Total trades"
            value={data.summary.totalTrades}
            hint={`${data.summary.wins}W / ${data.summary.losses}L / ${data.summary.ties}T`}
          />
          <StatCard
            label="Win rate"
            value={formatPercent(data.summary.winRate, { alreadyPercent: false, decimals: 1 })}
            icon={undefined}
          />
          <StatCard
            label="Net P/L"
            value={formatMoney(data.summary.netProfit, data.currency, { signed: true })}
            trend={data.summary.netProfit > 0 ? "up" : "down"}
          />
          <StatCard
            label="Profit factor"
            value={
              Number.isFinite(data.summary.profitFactor)
                ? data.summary.profitFactor.toFixed(2)
                : "∞"
            }
            trend={data.summary.profitFactor >= 1 ? "up" : "down"}
          />
          <StatCard
            label="Expectancy/trade"
            value={formatMoney(data.summary.expectancy, data.currency, { signed: true })}
          />
          <StatCard label="Avg win" value={formatMoney(data.summary.averageWin, data.currency)} />
          <StatCard label="Avg loss" value={formatMoney(data.summary.averageLoss, data.currency)} />
          <StatCard
            label="Max drawdown"
            value={formatMoney(data.summary.maxDrawdown, data.currency)}
            hint={formatPercent(data.summary.maxDrawdownPercent, {
              alreadyPercent: false,
              decimals: 1,
            })}
          />
          <StatCard
            label="Recovery factor"
            value={
              Number.isFinite(data.summary.recoveryFactor)
                ? data.summary.recoveryFactor.toFixed(2)
                : "∞"
            }
          />
          <StatCard label="Longest win streak" value={data.summary.longestWinStreak} />
          <StatCard label="Longest loss streak" value={data.summary.longestLossStreak} />
          <StatCard
            label="Current streak"
            value={
              data.summary.currentStreak > 0
                ? `${data.summary.currentStreak}W`
                : data.summary.currentStreak < 0
                  ? `${Math.abs(data.summary.currentStreak)}L`
                  : "—"
            }
          />
        </div>
      </Card>

      {/* Followed-plan vs broke-plan */}
      <Card className="p-5 print:border-0 print:shadow-none">
        <h2 className="text-base font-semibold mb-3">Discipline</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-md border border-profit/30 bg-profit/5 p-3">
            <div className="text-xs text-profit font-medium">
              Followed plan ({data.summary.followedPlanCount})
            </div>
            <div className="text-xl font-bold tabular-nums">
              {formatPercent(data.summary.followedPlanWinRate, {
                alreadyPercent: false,
                decimals: 1,
              })}
            </div>
          </div>
          <div className="rounded-md border border-loss/30 bg-loss/5 p-3">
            <div className="text-xs text-loss font-medium">
              Broke plan ({data.summary.brokePlanCount})
            </div>
            <div className="text-xl font-bold tabular-nums">
              {formatPercent(data.summary.brokePlanWinRate, { alreadyPercent: false, decimals: 1 })}
            </div>
          </div>
        </div>
      </Card>

      {/* Equity curve */}
      {data.equityCurve.length > 0 && (
        <Card className="p-5 print:border-0 print:shadow-none">
          <h2 className="text-base font-semibold mb-2">Equity curve</h2>
          <EquityCurveChart data={data.equityCurve} height={250} />
        </Card>
      )}

      {/* Best/worst assets */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Best asset"
          value={data.bestAsset?.key ?? "—"}
          delta={
            data.bestAsset
              ? `${formatPercent(data.bestAsset.winRate, { alreadyPercent: false, decimals: 0 })} WR · ${data.bestAsset.count} trades`
              : undefined
          }
          trend="up"
        />
        <StatCard
          label="Worst asset"
          value={data.worstAsset?.key ?? "—"}
          delta={
            data.worstAsset
              ? `${formatPercent(data.worstAsset.winRate, { alreadyPercent: false, decimals: 0 })} WR · ${data.worstAsset.count} trades`
              : undefined
          }
          trend="down"
        />
      </div>

      {/* Rule breaches + overrides */}
      <Card className="p-5 print:border-0 print:shadow-none">
        <h2 className="text-base font-semibold mb-3 flex items-center gap-1.5">
          <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
          Rule breaches &amp; overrides
        </h2>
        {data.ruleBreaches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No lockouts or overrides in this period. Good discipline!
          </p>
        ) : (
          <ul className="space-y-2">
            {data.ruleBreaches.map((b, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 text-sm border border-border rounded-md p-2"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {b.reason}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(b.startedAt, { withTime: true })}
                  </span>
                </div>
                <div className="text-xs">
                  {b.overriddenAt ? (
                    <span className="text-loss">Overridden: {b.overrideReason}</span>
                  ) : b.expiresAt ? (
                    <span className="text-muted-foreground">
                      Expires: {formatDate(b.expiresAt)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No expiry</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.auditEntries.length > 0 && (
          <div className="mt-3">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-1">
              Audit trail
            </h3>
            <ul className="text-xs space-y-1">
              {data.auditEntries.map((a, i) => (
                <li key={i} className="text-muted-foreground">
                  {formatDate(a.createdAt, { withTime: true })} — {a.action}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Session notes + journal entries */}
      <Card className="p-5 print:border-0 print:shadow-none">
        <h2 className="text-base font-semibold mb-3 flex items-center gap-1.5">
          <FileText className="size-4" aria-hidden="true" />
          Notes &amp; reflections
        </h2>
        {data.sessionNotes.length === 0 && data.journalEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No session notes or journal entries for this period.
          </p>
        ) : (
          <div className="space-y-3">
            {data.sessionNotes.map((s, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                <div className="text-xs text-muted-foreground mb-1">
                  Session {formatDate(s.startedAt, { withTime: true })}
                  {s.endedAt && ` → ${formatDate(s.endedAt, { withTime: true })}`}
                  {s.mood && ` · ${s.mood}`}
                </div>
                {s.notes && <p className="text-sm italic">{s.notes}</p>}
              </div>
            ))}
            {data.journalEntries.map((j, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                <div className="text-xs text-muted-foreground mb-1">
                  Daily journal — {formatDate(j.date)}
                </div>
                <p className="text-sm italic">{j.text}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* CSV Import Wizard */}
      {showImport && (
        <ImportWizard
          accounts={data.accounts}
          activeAccountId={data.activeAccountId}
          onDone={() => {
            setShowImport(false);
            router.refresh();
          }}
        />
      )}

      {/* Backup/Restore */}
      {showBackup && (
        <BackupRestore
          onDone={() => {
            setShowBackup(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ─── Helper: trigger browser download ────────────────────────────────────

function downloadFile(content: string | ArrayBuffer, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Import Wizard ────────────────────────────────────────────────────────

function ImportWizard({
  accounts,
  activeAccountId,
  onDone,
}: {
  accounts: { id: string; name: string }[];
  activeAccountId: string | null;
  onDone: () => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [parsed, setParsed] = useState<{
    headers: string[];
    preview: Record<string, string>[];
    totalRows: number;
  } | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [accountId, setAccountId] = useState(activeAccountId ?? accounts[0]?.id ?? "");
  const [result, setResult] = useState<{
    imported: number;
    duplicates: number;
    errors: { row: number; message: string }[];
    message: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  async function parse() {
    setError(undefined);
    setResult(null);
    const fd = new FormData();
    fd.set("csv", csvText);
    startTransition(async () => {
      const res = await parseCSVAction(fd);
      if (!res.ok || !res.headers) {
        setError(res.message ?? "Parse failed.");
        return;
      }
      setParsed({ headers: res.headers, preview: res.preview!, totalRows: res.totalRows! });
      // Auto-map common column names.
      const autoMap: Record<string, string> = {};
      const lowerHeaders = res.headers.map((h) => h.toLowerCase());
      for (const [field, candidates] of Object.entries({
        asset: ["asset", "pair", "symbol"],
        direction: ["direction", "dir", "type"],
        stake: ["stake", "amount", "size"],
        payoutPercent: ["payout", "payout %", "payoutpercent"],
        expiryMinutes: ["expiry", "expiry (min)", "minutes"],
        openedAt: ["date", "opened at", "time", "datetime"],
        result: ["result", "outcome"],
        emotion: ["emotion"],
        followedPlan: ["followed plan", "plan"],
        notes: ["notes", "note", "comment"],
      })) {
        for (const c of candidates) {
          const idx = lowerHeaders.indexOf(c);
          if (idx >= 0) {
            autoMap[field] = res.headers[idx];
            break;
          }
        }
      }
      setColumnMap(autoMap);
    });
  }

  async function import_() {
    setError(undefined);
    const fd = new FormData();
    fd.set("csv", csvText);
    fd.set("tradingAccountId", accountId);
    fd.set("columnMap", JSON.stringify(columnMap));
    startTransition(async () => {
      const res = await importTradesAction(fd);
      setResult({
        imported: res.imported,
        duplicates: res.duplicates,
        errors: res.errors,
        message: res.message,
      });
      if (res.ok) {
        toast({ title: "Import complete", description: res.message });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Upload className="size-4" aria-hidden="true" />
        CSV Import Wizard
      </h2>

      {/* Step 1: paste CSV */}
      <div>
        <label className="text-xs text-muted-foreground">
          Paste CSV content (or use the template below):
        </label>
        <textarea
          rows={5}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
          placeholder={
            "asset,direction,stake,payoutPercent,expiryMinutes,openedAt,result\nEUR/USD,CALL,100,0.85,5,2026-10-26T10:00:00Z,WIN"
          }
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setCsvText(
              "asset,direction,stake,payoutPercent,expiryMinutes,openedAt,result\nEUR/USD,CALL,100,0.85,5,2026-10-26T10:00:00Z,WIN\nGBP/USD,PUT,50,0.90,10,2026-10-26T11:00:00Z,LOSS",
            )
          }
        >
          Load template
        </Button>
      </div>

      {/* Account selector */}
      <div>
        <label className="text-xs text-muted-foreground">Import to account:</label>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="ml-2 h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <Button onClick={parse} disabled={pending || !csvText.trim()} size="sm">
        Parse & preview
      </Button>

      {/* Step 2: column mapping */}
      {parsed && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold">Map columns ({parsed.totalRows} rows detected)</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[
              "asset",
              "direction",
              "stake",
              "payoutPercent",
              "expiryMinutes",
              "openedAt",
              "result",
              "emotion",
              "followedPlan",
              "notes",
            ].map((field) => (
              <div key={field}>
                <label className="text-[10px] text-muted-foreground">{field}</label>
                <select
                  value={columnMap[field] ?? ""}
                  onChange={(e) => setColumnMap({ ...columnMap, [field]: e.target.value })}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">— skip —</option>
                  {parsed.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* Preview */}
          <div className="rounded-md border border-border overflow-x-auto max-h-40 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  {parsed.headers.map((h) => (
                    <th key={h} className="px-2 py-1 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.preview.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {parsed.headers.map((h) => (
                      <td key={h} className="px-2 py-1">
                        {row[h]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Button onClick={import_} disabled={pending} size="sm" variant="default">
            {pending ? "Importing…" : `Import ${parsed.totalRows} rows`}
          </Button>
        </div>
      )}

      {/* Step 3: results */}
      {result && (
        <div className="space-y-2">
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">{result.message}</p>
            {result.imported > 0 && (
              <p className="text-profit text-xs mt-1">✓ {result.imported} trades imported</p>
            )}
            {result.duplicates > 0 && (
              <p className="text-amber-600 dark:text-amber-400 text-xs">
                ↻ {result.duplicates} duplicates skipped
              </p>
            )}
            {result.errors.length > 0 && (
              <div className="mt-2">
                <p className="text-loss text-xs font-medium">{result.errors.length} errors:</p>
                <ul className="text-xs text-muted-foreground mt-1 max-h-32 overflow-y-auto">
                  {result.errors.slice(0, 10).map((e, i) => (
                    <li key={i}>
                      Row {e.row}: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Card>
  );
}

// ─── Backup/Restore ───────────────────────────────────────────────────────

function BackupRestore({ onDone }: { onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [restoreJson, setRestoreJson] = useState("");
  const [result, setResult] = useState<string | undefined>();

  async function exportBackup() {
    startTransition(async () => {
      const res = await exportBackupAction();
      if (!res.ok || !res.data) {
        toast({ title: "Backup failed", variant: "destructive" });
        return;
      }
      const json = JSON.stringify(res.data, null, 2);
      downloadFile(
        json,
        `riskguard-backup-${new Date().toISOString().slice(0, 10)}.json`,
        "application/json",
      );
      toast({
        title: "Backup exported",
        description: `${res.data.trades.length} trades, ${res.data.accounts.length} accounts`,
      });
    });
  }

  async function restoreBackup() {
    if (!restoreJson.trim()) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("backup", restoreJson);
      const res = await restoreBackupAction(fd);
      if (res.ok) {
        toast({ title: "Backup restored", description: res.message });
        setResult(
          res.message +
            (res.imported
              ? ` — ${res.imported.accounts} accounts, ${res.imported.trades} trades, ${res.imported.transactions} transactions, ${res.imported.strategies} strategies`
              : ""),
        );
        onDone();
      } else {
        toast({ title: "Restore failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Database className="size-4" aria-hidden="true" />
        Backup &amp; Restore
      </h2>

      <div>
        <Button onClick={exportBackup} disabled={pending} size="sm">
          <Download className="size-4 mr-1.5" aria-hidden="true" />
          {pending ? "Exporting…" : "Export full backup (JSON)"}
        </Button>
      </div>

      <div className="border-t border-border pt-4">
        <label className="text-xs text-muted-foreground">Paste backup JSON to restore:</label>
        <textarea
          rows={5}
          value={restoreJson}
          onChange={(e) => setRestoreJson(e.target.value)}
          className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
          placeholder='{"version":"1.0","exportedAt":"...","user":{...},...}'
        />
        <div className="mt-2 rounded-md border border-loss/30 bg-loss/5 p-2 text-xs text-loss">
          ⚠️ Restore replaces ALL your current data. This cannot be undone.
        </div>
        <ConfirmDialog
          destructive
          trigger={
            <Button
              variant="destructive"
              size="sm"
              disabled={pending || !restoreJson.trim()}
              className="mt-2"
            >
              Restore from JSON
            </Button>
          }
          title="Replace all your data?"
          description="This will delete ALL your current trades, accounts, strategies, and settings, then restore from the pasted JSON. This cannot be undone."
          confirmLabel="Yes, replace everything"
          onConfirm={restoreBackup}
        />
        {result && <p className="text-xs text-profit mt-2">{result}</p>}
      </div>
    </Card>
  );
}
