/**
 * Rate limiter for auth endpoints (PROJECT_RULES.md Phase 2: "rate limiting on
 * auth endpoints").
 *
 * Strategy: Upstash Ratelimit (sliding window) when UPSTASH_REDIS_REST_URL is
 * set; otherwise a per-process in-memory limiter for dev. Both expose the same
 * `rateLimit(key, opts)` interface so call sites don't care.
 *
 * Limits:
 *   - login attempts:         10 per 10 minutes per IP+email
 *   - register attempts:      5 per 10 minutes per IP
 *   - forgot-password:       5 per 10 minutes per IP+email
 *   - reset-password submit:  10 per 10 minutes per IP
 *   - verify-email submit:   10 per 10 minutes per IP
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number; // epoch ms
};

interface RateLimiter {
  limit(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
}

// ─── In-memory limiter (dev fallback) ────────────────────────────────────────
//
// Simple sliding-window counter. Per-process — not for prod. Reset every
// window so memory stays bounded.

class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  async limit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const entry = this.buckets.get(key);
    if (!entry || entry.resetAt < now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return {
        success: 1 <= limit,
        limit,
        remaining: Math.max(0, limit - 1),
        reset: now + windowMs,
      };
    }
    entry.count++;
    const remaining = Math.max(0, limit - entry.count);
    return {
      success: entry.count <= limit,
      limit,
      remaining,
      reset: entry.resetAt,
    };
  }
}

// ─── Upstash limiter (prod) ──────────────────────────────────────────────────

class UpstashRateLimiter implements RateLimiter {
  private ratelimiters = new Map<string, Ratelimit>();

  private getLimiter(limit: number, windowSec: number): Ratelimit {
    const cacheKey = `${limit}:${windowSec}`;
    let rl = this.ratelimiters.get(cacheKey);
    if (!rl) {
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      });
      rl = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowSec}s`),
        analytics: true,
      });
      this.ratelimiters.set(cacheKey, rl);
    }
    return rl;
  }

  async limit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const rl = this.getLimiter(limit, windowSec);
    const { success, limit: lim, remaining, reset } = await rl.limit(key);
    return {
      success,
      limit: lim,
      remaining,
      reset,
    };
  }
}

// ─── Singleton factory ───────────────────────────────────────────────────────

let _limiter: RateLimiter | null = null;

function getLimiter(): RateLimiter {
  if (_limiter) return _limiter;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _limiter = new UpstashRateLimiter();
  } else {
    _limiter = new MemoryRateLimiter();
  }
  return _limiter;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  return getLimiter().limit(key, limit, windowSec);
}

// Pre-tuned helpers — call sites just pick a name.
export function rateLimitLogin(ip: string, email: string) {
  return rateLimit(`login:${ip}:${email.toLowerCase()}`, 10, 600);
}
export function rateLimitRegister(ip: string) {
  return rateLimit(`register:${ip}`, 5, 600);
}
export function rateLimitForgotPassword(ip: string, email: string) {
  return rateLimit(`forgot:${ip}:${email.toLowerCase()}`, 5, 600);
}
export function rateLimitResetPassword(ip: string) {
  return rateLimit(`reset:${ip}`, 10, 600);
}
export function rateLimitVerifyEmail(ip: string) {
  return rateLimit(`verify:${ip}`, 10, 600);
}

// ─── Phase 25: Google OAuth + sign-out-of-all-devices rate limiting ─────────
//
// Google sign-in is rate-limited inside the signIn callback. Limits match
// the credential login window (10 / 600s per IP+email) so an attacker can't
// brute-force OAuth account enumeration. Sign-out-of-all-devices is rate-
// limited per-user (5 / 600s) so a compromised session can't be mass-
// invalidated by an attacker hammering the action.
export function rateLimitGoogleSignIn(ip: string, email: string) {
  return rateLimit(`google-signin:${ip}:${email.toLowerCase()}`, 10, 600);
}

export function rateLimitSignOutAll(userId: string) {
  return rateLimit(`signout-all:${userId}`, 5, 600);
}

export function rateLimitUnlinkAccount(userId: string) {
  return rateLimit(`unlink:${userId}`, 5, 600);
}

// Helper to extract IP from a Next.js Request — falls back to "unknown".
export function getRequestIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
