"use client";

/**
 * Phase 30.2 — "Ask your journal" panel on the Reports page.
 *
 * The panel is inert until the user opts in via Settings. It only calls
 * server actions; no provider key or AI code is ever imported here. Each
 * assistant bubble exposes the exact payload that was shared, and the
 * disclaimer is shown in the panel footer (PROJECT_RULES.md rule #11).
 */
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Bot, MessageCircle, Plus, ShieldCheck, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import {
  createCoachConversationAction,
  getCoachConversationAction,
  listCoachConversationsAction,
  sendCoachMessageAction,
  type CoachConversationRow,
  type CoachMessageRow,
} from "@/server/actions/coach";

type CoachPanelProps = {
  enabled: boolean;
  includeNotes: boolean;
  quota: number;
  usedToday: number;
};

export function CoachPanel({ enabled, includeNotes, quota, usedToday }: CoachPanelProps) {
  const [conversations, setConversations] = useState<CoachConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CoachMessageRow[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  // Load the most recent thread on mount (opt-in users only).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const listed = await listCoachConversationsAction();
      if (cancelled || !listed.ok || !listed.data?.length) return;
      setConversations(listed.data);
      setActiveId(listed.data[0].id);
      const loaded = await getCoachConversationAction(listed.data[0].id);
      if (!cancelled && loaded.ok && loaded.data) setMessages(loaded.data.messages);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  function selectConversation(id: string) {
    if (id === activeId || busy) return;
    setError(null);
    startTransition(async () => {
      const res = await getCoachConversationAction(id);
      if (!res.ok || !res.data) {
        setError(res.message);
        return;
      }
      setActiveId(id);
      setMessages(res.data.messages);
    });
  }

  function newConversation() {
    if (busy) return;
    setError(null);
    startTransition(async () => {
      const res = await createCoachConversationAction();
      if (!res.ok || !res.data) {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
        return;
      }
      setConversations((prev) => [res.data!, ...prev]);
      setActiveId(res.data.id);
      setMessages([]);
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setError(null);
    setQuestion("");
    const optimistic: CoachMessageRow[] = [
      ...messages,
      {
        id: `local-user-${Date.now()}`,
        role: "user",
        content: text,
        sharedContext: null,
        source: null,
        createdAt: new Date(),
      },
    ];
    setMessages(optimistic);
    startTransition(async () => {
      const res = await sendCoachMessageAction({ conversationId: activeId, content: text });
      if (!res.ok || !res.data) {
        setMessages(messages); // revert optimistic bubble
        setError(res.message);
        toast({ title: "Couldn't send", description: res.message, variant: "destructive" });
        return;
      }
      const { conversationId, reply } = res.data;
      setActiveId(conversationId);
      if (!activeId) {
        const listed = await listCoachConversationsAction();
        if (listed.ok && listed.data) setConversations(listed.data);
      }
      setMessages([
        ...optimistic,
        {
          id: `local-ai-${Date.now()}`,
          role: "assistant",
          content: reply.content,
          sharedContext: reply.sharedContext,
          source: reply.source,
          createdAt: new Date(),
        },
      ]);
    });
  }

  if (!enabled) {
    return (
      <div className="rounded-lg border border-border p-4 space-y-2" data-testid="coach-panel">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <MessageCircle className="size-4" aria-hidden="true" />
          Ask your journal
        </h2>
        <p className="text-xs text-muted-foreground">
          Opt in to reflect on your own trading journal with an AI coach. Aggregates are shared by
          default; your notes are never shared unless you explicitly allow it.
        </p>
        <Link href="/app/settings" className="text-xs underline underline-offset-2">
          Enable in Settings →
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4 space-y-3" data-testid="coach-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Sparkles className="size-4" aria-hidden="true" />
          Ask your journal
        </h2>
        <Button variant="outline" size="sm" onClick={newConversation} disabled={busy}>
          <Plus className="size-3.5 mr-1" aria-hidden="true" />
          New reflection
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded bg-info/15 px-1.5 py-0.5 text-info">
          <ShieldCheck className="size-3" aria-hidden="true" />
          {includeNotes ? "Aggregates + your notes" : "Aggregates only"}
        </span>
        <span data-testid="coach-quota">
          {Math.max(0, quota - usedToday)} of {quota} reflections left today
        </span>
      </div>

      {conversations.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => selectConversation(c.id)}
              disabled={busy}
              className={`max-w-48 truncate rounded-md border px-2 py-1 text-left text-[11px] ${
                c.id === activeId
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.title}
            </button>
          ))}
        </div>
      )}

      <div
        className="h-72 space-y-3 overflow-y-auto rounded-md border border-border bg-muted/20 p-3"
        data-testid="coach-messages"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Ask something about your recorded habits — for example, “What does my journal say about
            consistency?” This is a reflection tool, not a trading recommendation.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-md p-2.5 text-sm whitespace-pre-line ${
                m.role === "user"
                  ? "ml-8 bg-primary/10 text-foreground"
                  : "mr-8 bg-background border border-border"
              }`}
              data-testid={`coach-message-${m.role}`}
            >
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {m.role === "assistant" ? (
                  <>
                    <Bot className="size-3" aria-hidden="true" />
                    Coach {m.source === "fallback" ? "(rule-based)" : ""}
                  </>
                ) : (
                  "You"
                )}
              </div>
              {m.content}
              {m.role === "assistant" && m.sharedContext != null && (
                <details className="mt-2 text-[10px] text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    What data was shared
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 font-mono text-[9px] whitespace-pre-wrap">
                    {JSON.stringify(m.sharedContext, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))
        )}
        {busy && <p className="text-xs text-muted-foreground">Thinking…</p>}
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert" data-testid="coach-error">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about your own journal…"
          rows={2}
          maxLength={2000}
          disabled={busy}
          data-testid="coach-input"
          aria-label="Your question"
        />
        <Button
          type="submit"
          disabled={busy || question.trim().length === 0}
          data-testid="coach-send"
        >
          {busy ? "Sending…" : "Ask"}
        </Button>
      </form>

      <p className="text-[11px] text-muted-foreground" data-testid="coach-disclaimer">
        Discipline reflections only — not financial advice. Past results don&apos;t guarantee future
        outcomes.
      </p>
    </div>
  );
}
