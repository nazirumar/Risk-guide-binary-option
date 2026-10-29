"use client";

import { useState, useTransition, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/trader/FormField";
import { FormError, FormSuccess } from "@/components/auth/AuthShell";
import { AssetCombobox } from "./AssetCombobox";
import { PreTradeConfirmDialog } from "./PreTradeConfirmDialog";
import { MarketRatingPanel } from "./MarketRatingPanel";
import { AvoidWarningDialog, type AvoidWarningDialogState } from "./AvoidWarningDialog";
import { describeAvoidWarning } from "@/lib/market/trade-snapshot";
import type { ConfirmationSummary } from "@/lib/calc/confirmation";
import type { PrepareMarketInfo } from "@/server/actions/pre-trade-types";
import { createTradeAction } from "@/server/actions/trades";
import {
  prepareTradeConfirmationAction,
  cancelTradeAttemptAction,
} from "@/server/actions/pre-trade";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatMoney, formatPercent } from "@/lib/format";
import {
  potentialProfit,
  potentialLoss,
  riskAsPercentOfBalance,
  breakEvenWinRate,
} from "@/lib/calc/trade";
import { AlertTriangle, Loader2, Upload, X, Tag } from "lucide-react";
import { NextStakeSuggestionClient } from "@/components/staking/NextStakeSuggestionClient";
import { NewsTradeWarning } from "@/components/news/NewsTradeWarning";

type AccountLite = {
  id: string;
  name: string;
  broker: string;
  currency: string;
  type: "DEMO" | "REAL";
  currentBalance: Decimal | string;
};

type StrategyLite = {
  id: string;
  name: string;
  // Phase 20: per-strategy verdict shown beside the option + a warning when
  // the user picks a strategy with verdict="Likely losing". Optional so old
  // call-sites that haven't migrated to listStrategiesWithStatsAction still
  // work (verdict-less strategies just don't get a badge).
  verdict?: string;
};

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const EMOTIONS = [
  { value: "CALM", label: "Calm" },
  { value: "CONFIDENT", label: "Confident" },
  { value: "FEARFUL", label: "Fearful" },
  { value: "GREEDY", label: "Greedy" },
  { value: "REVENGE", label: "Revenge" },
  { value: "TIRED", label: "Tired" },
  { value: "BORED", label: "Bored" },
];
const EXPIRY_PRESETS = [1, 3, 5, 10, 15, 30, 60];

/**
 * AddTradeForm — fast, keyboard-friendly, mobile-first trade entry.
 *
 * Live preview: shows potential profit / potential loss / risk as % of
 * balance / break-even win rate based on current stake + payout.
 *
 * Calls createTradeAction — which runs the risk-check stub (Phase 5 returns
 * allowed:true; Phase 7 fills in real rules). If severity=WARN, we show a
 * confirm dialog before saving; BLOCK prevents saving.
 */
export function AddTradeForm({
  accounts,
  activeAccountId,
  strategies,
  nextStakeSuggestion,
}: {
  accounts: AccountLite[];
  activeAccountId: string | null;
  strategies: StrategyLite[];
  nextStakeSuggestion?: {
    suggestedStake: string;
    planName: string;
    clamped: boolean;
  } | null;
}) {
  const [form, setForm] = useState({
    tradingAccountId: activeAccountId ?? accounts[0]?.id ?? "",
    asset: "EUR/USD",
    direction: "CALL" as "CALL" | "PUT",
    stake: "",
    payoutPercent: "0.85",
    expiryMinutes: "5",
    strategyId: "",
    timeframe: "M5",
    emotion: "CALM" as "CALM" | "CONFIDENT" | "FEARFUL" | "GREEDY" | "REVENGE" | "TIRED" | "BORED",
    followedPlan: true,
    setupNotes: "",
    screenshotUrl: "",
    tags: [] as string[],
  });
  const [tagInput, setTagInput] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [uploadPending, setUploadPending] = useState(false);
  // Phase 17: holds the prepare result while the TILT dialog is open, so
  // "Continue anyway" can proceed to the confirmation step without re-running
  // the server checks (and without creating a second TiltEvent).
  const heldPrepareRef = useRef<Awaited<ReturnType<typeof prepareTradeConfirmationAction>> | null>(
    null,
  );
  const [tiltResult, setTiltResult] = useState<{
    score: number;
    level: "CALM" | "CAUTION" | "TILT";
    signals: { signal: string; weight: number; detail: string }[];
  } | null>(null);
  // Phase 17: the pending confirmation — populated when prepare passes the
  // risk + tilt checks and the user's settings require the modal.
  const [confirmState, setConfirmState] = useState<{
    token: string;
    notBefore: string;
    summary: ConfirmationSummary;
    warnings: string[];
    requirePlanCheckbox: boolean;
    reasonMode: "OFF" | "OPTIONAL" | "REQUIRED";
    /** Phase 29: live rating + personal edge for the confirmation screen. */
    market?: PrepareMarketInfo;
  } | null>(null);
  // Phase 29: the AVOID market-warning dialog — holds the prepare result so
  // "Continue anyway" proceeds without re-running the server checks.
  const [avoidState, setAvoidState] = useState<AvoidWarningDialogState | null>(null);
  /** Set when the trader continues past the AVOID dialog; consumed by the
   *  next save so the choice is stored on the Trade row. */
  const ignoredAvoidRef = useRef(false);
  const router = useRouter();

  const activeAccount = accounts.find((a) => a.id === form.tradingAccountId);
  const balance = activeAccount
    ? new Decimal(activeAccount.currentBalance.toString())
    : new Decimal(0);

  // Live preview math — memoized so it only recomputes when stake/payout/balance change.
  const preview = useMemo(() => {
    const stakeNum = Number(form.stake);
    const payoutNum = Number(form.payoutPercent);
    if (!Number.isFinite(stakeNum) || stakeNum <= 0 || !Number.isFinite(payoutNum)) {
      return null;
    }
    const profit = potentialProfit(stakeNum, payoutNum);
    const loss = potentialLoss(stakeNum);
    const riskPct = riskAsPercentOfBalance(stakeNum, balance);
    const breakEven = breakEvenWinRate(payoutNum);
    return { profit, loss, riskPct, breakEven };
  }, [form.stake, form.payoutPercent, balance]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t || form.tags.includes(t) || form.tags.length >= 20) return;
    set("tags", [...form.tags, t]);
    setTagInput("");
  }
  function removeTag(t: string) {
    set(
      "tags",
      form.tags.filter((x) => x !== t),
    );
  }

  async function onUploadScreenshot(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadPending(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed.");
      set("screenshotUrl", json.url);
      toast({ title: "Screenshot uploaded" });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploadPending(false);
      // Reset input so the same file can be re-selected.
      e.target.value = "";
    }
  }

  function buildFormData(): FormData {
    const fd = new FormData();
    fd.set("tradingAccountId", form.tradingAccountId);
    fd.set("asset", form.asset);
    fd.set("direction", form.direction);
    fd.set("stake", form.stake);
    fd.set("payoutPercent", form.payoutPercent);
    fd.set("expiryMinutes", form.expiryMinutes);
    if (form.strategyId) fd.set("strategyId", form.strategyId);
    if (form.timeframe) fd.set("timeframe", form.timeframe);
    if (form.emotion) fd.set("emotion", form.emotion);
    fd.set("followedPlan", form.followedPlan ? "true" : "false");
    if (form.setupNotes) fd.set("setupNotes", form.setupNotes);
    if (form.screenshotUrl) fd.set("screenshotUrl", form.screenshotUrl);
    for (const tag of form.tags) fd.append("tags", tag);
    // Phase 29: the AVOID-warning choice (server re-verifies the rating).
    if (ignoredAvoidRef.current) fd.set("ignoredAvoidWarning", "true");
    return fd;
  }

  /** Phase 17 step 3a: the actual save with the signed confirmation token. */
  function doSave(token: string | undefined, followedPlan: boolean, entryReason: string | null) {
    startTransition(async () => {
      const fd = buildFormData();
      if (token) fd.set("confirmationToken", token);
      fd.set("followedPlan", followedPlan ? "true" : "false");
      if (entryReason && entryReason.trim().length > 0) fd.set("entryReason", entryReason.trim());
      const res = await createTradeAction(fd);
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        setError(res.message);
        setConfirmState(null);
        return;
      }
      setConfirmState(null);
      toast({ title: "Trade saved", description: res.message });
      ignoredAvoidRef.current = false;
      // Reset only the volatile fields; keep account/asset/strategy/direction.
      setForm((f) => ({ ...f, stake: "", setupNotes: "", screenshotUrl: "", tags: [] }));
      setTagInput("");
      router.refresh();
    });
  }

  /** Phase 17 step 3b: cancel from the modal — record the avoided trade. */
  function onCancelConfirm(details: { planChecked: boolean; entryReason: string }) {
    const { planChecked, entryReason } = details;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("stake", form.stake || "0");
      fd.set("asset", form.asset || "unknown");
      if (entryReason && entryReason.trim().length > 0) fd.set("reason", entryReason.trim());
      // Only meaningful when the checkbox was actually rendered — otherwise
      // the default `false` would hijack the cancellation reason.
      if (confirmState?.requirePlanCheckbox) {
        fd.set("planChecked", planChecked ? "true" : "false");
      }
      if (confirmState) fd.set("reasonMode", confirmState.reasonMode);
      const res = await cancelTradeAttemptAction(fd);
      setConfirmState(null);
      if (res.ok) {
        toast({
          title: "Trade cancelled",
          description: "Logged under \u201cTrades you avoided\u201d. Discipline kept.",
        });
      } else {
        setError(res.message);
      }
      router.refresh();
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setFieldErrors({});

    startTransition(async () => {
      // Each submit re-evaluates the AVOID warning against fresh conditions —
      // an acknowledgement only applies to the prepare→save cycle after it.
      ignoredAvoidRef.current = false;

      // Phase 17 step 1: prepare — validate + risk check + tilt check + issue
      // the signed confirmation token. Nothing is saved yet.
      const prep = await prepareTradeConfirmationAction(buildFormData());
      if (!prep.ok) {
        if (prep.fieldErrors) setFieldErrors(prep.fieldErrors);
        if (prep.severity === "BLOCK" && prep.reasons?.length) {
          setError(`Trade blocked: ${prep.reasons.join("; ")}`);
        } else {
          setError(prep.message);
        }
        return;
      }

      // Tilt TILT routes to the tilt dialog BEFORE the confirmation modal.
      if (prep.tilt && prep.tilt.level === "TILT") {
        setTiltResult(prep.tilt);
        // Hold the prepared confirmation for "Continue anyway".
        heldPrepareRef.current = prep;
        return;
      }

      // CAUTION keeps the yellow banner visible behind/after the modal.
      if (prep.tilt && prep.tilt.level === "CAUTION") {
        setTiltResult(prep.tilt);
      }

      // Phase 29: AVOID market warning — confirm before proceeding. Advisory:
      // the trader may continue, and the choice is logged on the trade.
      if (prep.market?.avoidConfirmRequired) {
        openAvoidDialog(prep);
        return;
      }

      proceedWithPrepared(prep);
    });
  }

  /** Extracted Phase 17 step 2: open the confirmation modal, or save directly
   *  when the user's DEMO setting skips it. */
  function proceedWithPrepared(prep: Awaited<ReturnType<typeof prepareTradeConfirmationAction>>) {
    if (prep.needsConfirmation && prep.confirmationToken && prep.summary && prep.notBefore) {
      setConfirmState({
        token: prep.confirmationToken,
        notBefore: prep.notBefore,
        summary: prep.summary,
        warnings: prep.severity === "WARN" && prep.reasons?.length ? prep.reasons : [],
        requirePlanCheckbox: prep.settings?.requirePlanCheckbox ?? false,
        reasonMode: prep.settings?.reasonMode ?? "OPTIONAL",
        market: prep.market,
      });
      return;
    }

    // Confirmation skipped (DEMO + user setting) — save immediately with
    // the token the server issued during prepare.
    doSaveDirect(prep.confirmationToken);
  }

  /** Phase 29: show the AVOID confirm dialog, holding the prepare result. */
  function openAvoidDialog(prep: Awaited<ReturnType<typeof prepareTradeConfirmationAction>>) {
    const described = describeAvoidWarning({
      rating: prep.market?.rating ?? null,
      score: prep.market?.score ?? null,
      reasons: prep.market?.reasons ?? [],
      nextNewsTitle: prep.market?.nextNewsTitle ?? null,
      nextNewsMinutesTo: prep.market?.nextNewsMinutesTo ?? null,
    });
    setAvoidState({
      headline: described.headline,
      reasons: described.reasons,
      ratingScore: prep.market?.score ?? null,
    });
    heldPrepareRef.current = prep;
  }

  /** "Continue anyway" on the AVOID dialog — proceed with the held prepare
   *  and stamp the choice onto the trade (server re-verifies the rating). */
  function onAvoidContinue() {
    const prep = heldPrepareRef.current;
    heldPrepareRef.current = null;
    setAvoidState(null);
    ignoredAvoidRef.current = true;
    if (!prep) return;
    proceedWithPrepared(prep);
  }

  /** Cancel from the AVOID dialog — record it as a traded-you-avoided row. */
  function onAvoidCancel() {
    heldPrepareRef.current = null;
    setAvoidState(null);
    ignoredAvoidRef.current = false;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("stake", form.stake || "0");
      fd.set("asset", form.asset || "unknown");
      fd.set("reason", "Cancelled at the AVOID market warning.");
      const res = await cancelTradeAttemptAction(fd);
      if (res.ok) {
        toast({
          title: "Trade cancelled",
          description: "Logged under \u201cTrades you avoided\u201d. Discipline kept.",
        });
      } else {
        setError(res.message);
      }
      router.refresh();
    });
  }

  /** Save on the skip path (no modal) — wraps doSave inside the transition. */
  function doSaveDirect(token: string | undefined) {
    // Already inside startTransition — call the save logic directly.
    const fd = buildFormData();
    if (token) fd.set("confirmationToken", token);
    void (async () => {
      const res = await createTradeAction(fd);
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        setError(res.message);
        return;
      }
      toast({ title: "Trade saved", description: res.message });
      ignoredAvoidRef.current = false;
      setForm((f) => ({ ...f, stake: "", setupNotes: "", screenshotUrl: "", tags: [] }));
      setTagInput("");
      router.refresh();
    })();
  }

  function onConfirmFromDialog(details: { planChecked: boolean; entryReason: string }) {
    if (!confirmState) return;
    const followedPlan = confirmState.requirePlanCheckbox ? details.planChecked : form.followedPlan;
    doSave(confirmState.token, followedPlan, details.entryReason);
  }

  function dismissTilt() {
    setTiltResult(null);
    // Phase 17: "Continue anyway" proceeds to the confirmation step (or a
    // direct save when the modal is skipped for DEMO accounts).
    const prep = heldPrepareRef.current;
    heldPrepareRef.current = null;
    if (!prep) return;
    // Phase 29: the AVOID warning still applies after the tilt dialog —
    // re-queue it the same way the submit flow does.
    if (prep.market?.avoidConfirmRequired) {
      openAvoidDialog(prep);
      return;
    }
    proceedWithPrepared(prep);
  }

  async function takeTiltBreak() {
    const fd = new FormData();
    startTransition(async () => {
      const { createTiltBreakAction } = await import("@/server/actions/tilt");
      const res = await createTiltBreakAction(fd);
      if (res.ok) {
        toast({ title: "Tilt break lockout active", description: res.message });
        setTiltResult(null);
        heldPrepareRef.current = null; // discard the held confirmation — the lockout will block the save anyway
        router.refresh();
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {/* Row 1: Account + Asset */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          label="Account"
          htmlFor="tradingAccountId"
          error={fieldErrors.tradingAccountId}
          required
        >
          <select
            id="tradingAccountId"
            value={form.tradingAccountId}
            onChange={(e) => set("tradingAccountId", e.target.value)}
            disabled={pending || accounts.length === 0}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.broker} · {a.type === "DEMO" ? "DEMO" : "REAL"} (
                {formatMoney(a.currentBalance, a.currency)})
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Asset" htmlFor="asset" error={fieldErrors.asset} required>
          <AssetCombobox value={form.asset} onChange={(v) => set("asset", v)} disabled={pending} />
          {/* Phase 29: live market rating beside the pair — GOOD/CAUTION/AVOID
              or "No market data" for OTC/unknown instruments (never guessed). */}
          <MarketRatingPanel asset={form.asset} tradingAccountId={form.tradingAccountId} />
        </FormField>
      </div>

      {/* Row 2: Direction + Stake + Payout */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <FormField label="Direction" htmlFor="direction" required>
          <div className="grid grid-cols-2 gap-1.5">
            {(["CALL", "PUT"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => set("direction", d)}
                aria-pressed={form.direction === d}
                className={cn(
                  "h-11 rounded-md border px-3 text-sm font-bold",
                  form.direction === d
                    ? d === "CALL"
                      ? "border-profit bg-profit/15 text-profit"
                      : "border-loss bg-loss/15 text-loss"
                    : "border-input bg-background hover:bg-accent",
                )}
                disabled={pending}
              >
                {d === "CALL" ? "▲ CALL" : "▼ PUT"}
              </button>
            ))}
          </div>
        </FormField>
        <FormField
          label="Stake"
          htmlFor="stake"
          error={fieldErrors.stake}
          required
          hint={
            activeAccount ? `Balance: ${formatMoney(balance, activeAccount.currency)}` : undefined
          }
        >
          <Input
            id="stake"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            value={form.stake}
            onChange={(e) => set("stake", e.target.value)}
            disabled={pending}
            placeholder="0.00"
            autoFocus
          />
          <NextStakeSuggestionClient
            suggestion={nextStakeSuggestion ?? null}
            onApply={(stake) => set("stake", stake)}
          />
        </FormField>
        <FormField
          label="Payout %"
          htmlFor="payoutPercent"
          error={fieldErrors.payoutPercent}
          required
          hint="Broker's payout as a fraction — e.g. 0.85 for 85%."
        >
          <Input
            id="payoutPercent"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            max="1"
            value={form.payoutPercent}
            onChange={(e) => set("payoutPercent", e.target.value)}
            disabled={pending}
          />
        </FormField>
      </div>

      {/* Row 3: Expiry + Strategy + Timeframe */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <FormField
          label="Expiry (min)"
          htmlFor="expiryMinutes"
          error={fieldErrors.expiryMinutes}
          required
        >
          <div className="flex gap-1.5 items-center">
            <Input
              id="expiryMinutes"
              type="number"
              step="1"
              min="1"
              max="1440"
              value={form.expiryMinutes}
              onChange={(e) => set("expiryMinutes", e.target.value)}
              disabled={pending}
              className="flex-1"
            />
            <div className="flex gap-1 shrink-0">
              {EXPIRY_PRESETS.filter((p) => String(p) !== form.expiryMinutes)
                .slice(0, 3)
                .map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set("expiryMinutes", String(p))}
                    disabled={pending}
                    className="h-11 px-2 text-xs rounded-md border border-input hover:bg-accent"
                  >
                    {p}m
                  </button>
                ))}
            </div>
          </div>
        </FormField>
        <FormField label="Strategy" htmlFor="strategyId">
          <select
            id="strategyId"
            value={form.strategyId}
            onChange={(e) => set("strategyId", e.target.value)}
            disabled={pending || strategies.length === 0}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            data-testid="strategy-select"
          >
            <option value="">— none —</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.verdict && s.verdict !== "Not enough data"
                  ? ` · ${s.verdict}`
                  : s.verdict === "Not enough data"
                    ? " · not enough data"
                    : ""}
              </option>
            ))}
          </select>
          {/* Phase 20: warning when the user picks a strategy with "Likely losing"
              verdict. Non-blocking (the trader may have a good reason — the
              discipline move is to surface the stat, not to prevent the trade). */}
          {(() => {
            const selected = strategies.find((s) => s.id === form.strategyId);
            if (!selected?.verdict || selected.verdict !== "Likely losing") return null;
            return (
              <div
                className="mt-2 rounded-md border border-loss/40 bg-loss/10 p-2 text-xs text-loss"
                data-testid="likely-losing-strategy-warning"
              >
                ⚠ This strategy is statistically likely to lose money at the current win rate.
                Consider whether this trade fits your plan — past results don&apos;t guarantee
                future outcomes, but the historical evidence is not in your favor.
              </div>
            );
          })()}
          {/* Phase 22: news warning — non-blocking red panel when a high-impact
              event affects the traded pair's currencies within the warning window.
              Hidden when no relevant events exist or the user disabled the warning. */}
          <NewsTradeWarning asset={form.asset} />
        </FormField>
        <FormField label="Timeframe" htmlFor="timeframe">
          <select
            id="timeframe"
            value={form.timeframe}
            onChange={(e) => set("timeframe", e.target.value)}
            disabled={pending}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {/* Row 4: Emotion + Followed plan */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Emotion" htmlFor="emotion">
          <select
            id="emotion"
            value={form.emotion}
            onChange={(e) => set("emotion", e.target.value as typeof form.emotion)}
            disabled={pending}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {EMOTIONS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </FormField>
        <div className="flex items-end gap-3 pb-1">
          <Switch
            id="followedPlan"
            checked={form.followedPlan}
            onCheckedChange={(v) => set("followedPlan", v === true)}
            disabled={pending}
          />
          <Label htmlFor="followedPlan" className="text-sm font-medium leading-none cursor-pointer">
            I followed my plan
          </Label>
        </div>
      </div>

      {/* Row 5: Screenshot upload */}
      <FormField label="Screenshot (optional)" htmlFor="screenshot">
        <div className="flex gap-2 items-center">
          <label
            className={cn(
              "inline-flex items-center gap-2 h-11 px-4 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent cursor-pointer",
              (uploadPending || pending) && "opacity-50 pointer-events-none",
            )}
          >
            {uploadPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="size-4" aria-hidden="true" />
            )}
            {form.screenshotUrl ? "Replace" : "Upload"}
            <input
              id="screenshot"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={onUploadScreenshot}
              disabled={uploadPending || pending}
              className="sr-only"
            />
          </label>
          {form.screenshotUrl && (
            <Badge variant="secondary" className="gap-1">
              <a
                href={form.screenshotUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                View
              </a>
            </Badge>
          )}
        </div>
      </FormField>

      {/* Row 6: Notes */}
      <FormField label="Setup notes (optional)" htmlFor="setupNotes" error={fieldErrors.setupNotes}>
        <Textarea
          id="setupNotes"
          rows={3}
          value={form.setupNotes}
          onChange={(e) => set("setupNotes", e.target.value)}
          disabled={pending}
          placeholder="Why did you take this trade? Confluences, entry trigger, exit plan…"
        />
      </FormField>

      {/* Row 7: Tags */}
      <FormField label="Tags (optional)" htmlFor="tags" hint="Press Enter to add a tag. Max 20.">
        <div className="flex gap-2 flex-wrap items-center">
          {form.tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1">
              <Tag className="size-3" aria-hidden="true" />
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                disabled={pending}
                aria-label={`Remove tag ${t}`}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
          <Input
            id="tags"
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            disabled={pending || form.tags.length >= 20}
            placeholder="london-session, news, scalp…"
            className="flex-1 min-w-[160px] h-9"
          />
        </div>
      </FormField>

      {/* Live preview */}
      {preview && (
        <div className="rounded-md border border-border bg-muted/30 p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground uppercase">Potential profit</div>
            <div className="text-profit font-semibold tabular-nums">
              +{formatMoney(preview.profit, activeAccount?.currency ?? "USD")}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase">Potential loss</div>
            <div className="text-loss font-semibold tabular-nums">
              {formatMoney(preview.loss, activeAccount?.currency ?? "USD")}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase">Risk % of balance</div>
            <div
              className={cn(
                "font-semibold tabular-nums",
                preview.riskPct.gt(0.05)
                  ? "text-loss"
                  : preview.riskPct.gt(0.02)
                    ? "text-warning"
                    : "text-profit",
              )}
            >
              {formatPercent(preview.riskPct, { decimals: 2 })}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase">Break-even win %</div>
            <div className="font-semibold tabular-nums text-muted-foreground">
              {formatPercent(preview.breakEven, { decimals: 2 })}
            </div>
          </div>
        </div>
      )}

      <FormError message={error} />
      <FormSuccess message={success} />

      {/* Phase 16: Tilt CAUTION warning (yellow banner, non-blocking) */}
      {tiltResult && tiltResult.level === "CAUTION" && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200 space-y-1"
          role="status"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-4" aria-hidden="true" />
            Tilt caution — score {tiltResult.score}/100
          </p>
          <ul className="text-xs space-y-0.5 pl-5 list-disc">
            {tiltResult.signals.map((s) => (
              <li key={s.signal}>{s.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Phase 16: TILT dialog (red, blocking with choices) */}
      {tiltResult && tiltResult.level === "TILT" && (
        <div
          className="rounded-md border border-loss/40 bg-loss/10 p-4 text-sm text-loss space-y-3"
          role="alertdialog"
          aria-labelledby="tilt-title"
        >
          <p className="flex items-center gap-1.5 font-bold text-base">
            <AlertTriangle className="size-5" aria-hidden="true" />
            Tilt detected — score {tiltResult.score}/100
          </p>
          <ul className="text-xs space-y-1 pl-5 list-disc text-loss/80">
            {tiltResult.signals.map((s) => (
              <li key={s.signal}>{s.detail}</li>
            ))}
          </ul>
          <p className="text-xs">
            You&apos;re showing signs of tilt. We strongly recommend taking a break.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={takeTiltBreak}
              disabled={pending}
            >
              Take a 15-min break
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={dismissTilt}>
              Continue anyway
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="submit"
          disabled={pending || accounts.length === 0}
          data-testid="save-trade-button"
        >
          {pending && !confirmState ? "Checking…" : "Save trade"}
        </Button>
      </div>

      {/* Phase 17: Pre-trade confirmation modal — shown after risk + tilt
          checks pass. Cooldown is enforced against the server's notBefore.
          key={token} remounts per confirmation so state resets cleanly. */}
      {confirmState && (
        <PreTradeConfirmDialog
          key={confirmState.token}
          open
          summary={confirmState.summary}
          notBefore={confirmState.notBefore}
          warnings={confirmState.warnings}
          requirePlanCheckbox={confirmState.requirePlanCheckbox}
          reasonMode={confirmState.reasonMode}
          market={confirmState.market}
          pending={pending}
          onConfirm={onConfirmFromDialog}
          onCancel={onCancelConfirm}
        />
      )}

      {/* Phase 29: AVOID market-rating confirmation — advisory, always allows
          continuing; the choice is stored on the trade when saved. */}
      <AvoidWarningDialog
        state={avoidState}
        pending={pending}
        onContinue={onAvoidContinue}
        onCancel={onAvoidCancel}
      />
    </form>
  );
}
