/**
 * Phase 17 — Pre-trade confirmation shared types.
 *
 * Separate from pre-trade.ts because "use server" files may only export
 * async functions (Turbopack rule) — client components import the types from
 * here. Also mirrors the ConfirmationSummary type from the pure calc lib for
 * client-side consumption.
 */
import type { ConfirmationSummary } from "@/lib/calc/confirmation";

export type { ConfirmationSummary };

/** The user's pre-trade confirmation settings (mirrors User model fields). */
export type PreTradeSettings = {
  skipDemo: boolean;
  cooldownSeconds: number;
  requirePlanCheckbox: boolean;
  reasonMode: "OFF" | "OPTIONAL" | "REQUIRED";
};

/** Result of prepareTradeConfirmationAction — drives the Add Trade flow. */
export type PrepareConfirmationResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;

  /** Risk verdict. BLOCK stops the flow before any modal is shown. */
  severity?: "OK" | "WARN" | "BLOCK";
  reasons?: string[];

  /** Phase 16 tilt result. TILT routes to the tilt dialog, not the modal. */
  tilt?: {
    score: number;
    level: "CALM" | "CAUTION" | "TILT";
    signals: { signal: string; weight: number; detail: string }[];
  };

  /** Server-issued signed token. ALWAYS present when ok + risk not BLOCK —
   *  createTradeAction rejects saves without it when confirmation applies. */
  confirmationToken?: string;

  /** Whether the confirmation modal should be shown. False when the user
   *  opted out for DEMO accounts — the client then saves immediately.
   *  Only meaningful on ok:true responses. */
  needsConfirmation?: boolean;

  /** ISO instant before which the server will REJECT the save (cooldown). */
  notBefore?: string;
  /** ISO instant after which the token is invalid — must re-prepare. */
  expiresAt?: string;

  /** All modal numbers (computed server-side by buildConfirmationSummary). */
  summary?: ConfirmationSummary;

  /** The user's confirmation settings — the dialog needs these to render the
   *  plan checkbox + reason field without an extra fetch. */
  settings?: {
    requirePlanCheckbox: boolean;
    reasonMode: "OFF" | "OPTIONAL" | "REQUIRED";
  };
};

/** Result of cancelTradeAttemptAction. */
export type CancelAttemptResult = {
  ok: boolean;
  message: string;
};

/** Result of updatePreTradeSettingsAction. */
export type PreTradeSettingsResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

/** Extract a human-readable reason from the modal for CancelledTradeAttempt. */
export function describeCancelReason(
  typedReason: string | null,
  planChecked: boolean | null,
  reasonMode: PreTradeSettings["reasonMode"],
): string {
  if (typedReason && typedReason.trim().length > 0) return typedReason.trim();
  if (planChecked === false) return "Checked 'does not follow my plan', then stopped.";
  if (reasonMode === "REQUIRED") return "Cancelled at confirmation (no entry reason given).";
  return "Cancelled at the pre-trade confirmation screen.";
}
