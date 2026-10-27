/**
 * Phase 23 — Weekly AI review card on the Reports page.
 *
 * Server Component. Fetches the user's weekly reviews via
 * `listWeeklyReviewsAction` and renders the most recent one (with the
 * full history below). Shows the source badge (AI vs rule-based fallback)
 * + the aggregated metrics that were shared — transparency for the
 * privacy toggle.
 *
 * Includes a "Generate now" button (calls generateWeeklyReviewAction)
 * when the user has opted in.
 */
import Link from "next/link";
import { Sparkles, ShieldCheck } from "lucide-react";
import { listWeeklyReviewsAction } from "@/server/actions/ai-review";
import { EmptyState } from "@/components/trader/EmptyState";
import { GenerateReviewButton } from "@/components/reports/GenerateReviewButton";
import { formatDate } from "@/lib/format";

export async function WeeklyReviewCard({ aiEnabled }: { aiEnabled: boolean }) {
  const result = await listWeeklyReviewsAction();
  const reviews = result.reviews ?? [];
  const latest = reviews[0];

  return (
    <div className="rounded-lg border border-border p-4 space-y-4" data-testid="weekly-review-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Sparkles className="size-4" aria-hidden="true" />
          Weekly AI review
        </h2>
        {aiEnabled ? (
          <GenerateReviewButton />
        ) : (
          <Link
            href="/app/settings"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Enable in Settings →
          </Link>
        )}
      </div>

      {!latest ? (
        <EmptyState
          icon={Sparkles}
          title="No weekly reviews yet"
          description={
            aiEnabled
              ? "Your first review will be generated at the start of next week (or generate one for the current week now)."
              : "Enable the AI weekly review in Settings to receive a plain-language summary of each trading week. Only aggregated stats are shared — never your email, name, or screenshots."
          }
        />
      ) : (
        <>
          {/* Latest review */}
          <div
            className="rounded-md border border-border p-3 space-y-2"
            data-testid="latest-review"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                {formatDate(latest.weekStart)} – {formatDate(latest.weekEnd)}
              </div>
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  latest.source === "ai" ? "bg-info/15 text-info" : "bg-muted text-muted-foreground"
                }`}
                data-testid="review-source"
              >
                {latest.source === "ai" ? (
                  <>
                    <Sparkles className="size-3" aria-hidden="true" />
                    AI
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-3" aria-hidden="true" />
                    Rule-based
                  </>
                )}
              </span>
            </div>
            <p className="text-sm whitespace-pre-line">{latest.summary}</p>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Suggestions</div>
              <ol className="list-decimal list-inside space-y-1 text-sm">
                {latest.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
            {/* Metrics shared — transparency */}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                What data was shared
              </summary>
              <div className="mt-1 rounded-md bg-muted/30 p-2 font-mono text-[10px] whitespace-pre-wrap">
                {JSON.stringify(latest.metrics, null, 2)}
              </div>
            </details>
          </div>

          {/* History */}
          {reviews.length > 1 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Previous reviews ({reviews.length - 1})
              </summary>
              <div className="mt-2 space-y-2">
                {reviews.slice(1).map((r) => (
                  <div key={r.id} className="rounded-md border border-border p-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        {formatDate(r.weekStart)} – {formatDate(r.weekEnd)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{r.source}</span>
                    </div>
                    <p className="text-xs line-clamp-2">{r.summary}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
