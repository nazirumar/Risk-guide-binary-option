/**
 * Phase 30.0 — provider-agnostic AI client.
 *
 * All AI features (weekly review, coach, news classification, imports,
 * briefings) go through `getAIProvider()`. Groq is the default when
 * `GROQ_API_KEY` is set; the legacy Anthropic client is kept as a fallback so
 * existing deployments don't break. With neither key, callers get `null` and
 * use their deterministic rule-based fallback.
 *
 * Secrets stay server-side. No code in this module may be imported by a
 * Client Component.
 */

export type AICompletionOptions = {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export type AIImageInput = {
  /** Base64-encoded bytes (no data-URL prefix). */
  base64: string;
  /** e.g. "image/png". Only image/* is accepted by the implementation. */
  mimeType: string;
};

export interface AIProvider {
  /** Optional label used observability rows (e.g. "groq"). */
  readonly name?: string;
  /** Returns the raw text response; throws on failure (caller decides fallback). */
  complete(prompt: string, systemPrompt: string, options?: AICompletionOptions): Promise<string>;
  /**
   * Optional vision capability used only by statement-screenshot OCR. When it
   * is absent the caller asks the user to paste the statement text instead.
   * Model output is raw delimited text, normalized by pure import helpers.
   */
  completeWithImage?(
    prompt: string,
    systemPrompt: string,
    image: AIImageInput,
    options?: AICompletionOptions,
  ): Promise<string>;
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1024;
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function envTimeout(): number {
  const raw = nonEmpty(process.env.GROQ_TIMEOUT_MS);
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Groq's OpenAI-compatible chat completions API. */
export class GroqClient implements AIProvider {
  readonly name = "groq";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_GROQ_MODEL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly visionModel?: string,
  ) {}

  async complete(
    prompt: string,
    systemPrompt: string,
    options: AICompletionOptions = {},
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: options.temperature ?? 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new RateLimitError("Groq API rate limited (429).");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Groq API error ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("Groq API returned no text content.");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** OCR for statement screenshots. Requires GROQ_VISION_MODEL to be configured. */
  async completeWithImage(
    prompt: string,
    systemPrompt: string,
    image: AIImageInput,
    options: AICompletionOptions = {},
  ): Promise<string> {
    if (!this.visionModel) {
      throw new Error("No vision model configured (set GROQ_VISION_MODEL).");
    }
    if (!image.mimeType.startsWith("image/") || !image.base64) {
      throw new Error("A supported image (PNG/JPEG/WebP) is required for OCR.");
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.visionModel,
          max_tokens: options.maxTokens ?? 4096,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (res.status === 429) throw new RateLimitError("Groq OCR rate limited (429).");
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Groq OCR error ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("Groq OCR returned no text content.");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Legacy Anthropic client, retained as a fallback when no Groq key is set. */
export class RealAnthropicClient implements AIProvider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async complete(
    prompt: string,
    systemPrompt: string,
    options: AICompletionOptions = {},
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new RateLimitError("Anthropic API rate limited (429).");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
      };
      const text = data.content?.find((c) => c.type === "text")?.text;
      if (!text) throw new Error("Anthropic API returned no text content.");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

let _provider: AIProvider | null | undefined;

/**
 * Resolve the AI provider (cached singleton):
 *   1. Test-registered provider via `setAIProvider` / `setAnthropicClient`.
 *   2. `GroqClient` when `GROQ_API_KEY` is set (default model env-overridable).
 *   3. `RealAnthropicClient` when only `ANTHROPIC_API_KEY` is set.
 *   4. `null` — caller uses its rule-based fallback.
 */
export function getAIProvider(): AIProvider | null {
  if (_provider !== undefined) return _provider;

  const groqKey = nonEmpty(process.env.GROQ_API_KEY);
  if (groqKey) {
    _provider = new GroqClient(
      groqKey,
      nonEmpty(process.env.GROQ_MODEL) ?? DEFAULT_GROQ_MODEL,
      envTimeout(),
      nonEmpty(process.env.GROQ_VISION_MODEL),
    );
    return _provider;
  }

  const anthropicKey = nonEmpty(process.env.ANTHROPIC_API_KEY);
  _provider = anthropicKey ? new RealAnthropicClient(anthropicKey) : null;
  return _provider;
}

/** Test-only: register a provider (or `null` to force all callers to fallback). */
export function setAIProvider(provider: AIProvider | null): void {
  _provider = provider;
}

/** Test-only: clear the singleton so env vars are read again. */
export function resetAIProvider(): void {
  _provider = undefined;
}
