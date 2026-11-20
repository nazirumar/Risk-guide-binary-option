/**
 * Phase 30.0 — unit tests for the provider-agnostic AI layer.
 *
 * Pure unit tests: no DB, no network. `fetch` is stubbed for client tests and
 * the provider singleton is reset around every case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GroqClient,
  RateLimitError,
  RealAnthropicClient,
  getAIProvider,
  resetAIProvider,
  setAIProvider,
} from "@/lib/ai/provider";
import { getAnthropicClient, setAnthropicClient } from "@/lib/ai/review";

const AI_ENV_KEYS = ["GROQ_API_KEY", "GROQ_MODEL", "GROQ_TIMEOUT_MS", "ANTHROPIC_API_KEY"] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const key of AI_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetAIProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of AI_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAIProvider();
});

function mockFetchResponse(body: unknown, status = 200) {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ─── Provider resolution ─────────────────────────────────────────────────────

describe("getAIProvider", () => {
  it("returns null when no AI key is configured", () => {
    expect(getAIProvider()).toBeNull();
  });

  it("returns a GroqClient when GROQ_API_KEY is set", () => {
    process.env.GROQ_API_KEY = "groq-test-key";
    expect(getAIProvider()).toBeInstanceOf(GroqClient);
  });

  it("uses GROQ_MODEL when provided", async () => {
    process.env.GROQ_API_KEY = "groq-test-key";
    process.env.GROQ_MODEL = "custom-groq-model";
    const provider = getAIProvider() as GroqClient;
    // Model is private; verify via the outgoing request body instead.
    const fetchMock = mockFetchResponse({ choices: [{ message: { content: "ok" } }] });
    await provider.complete("prompt", "system");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("custom-groq-model");
  });

  it("prefers Groq over a configured Anthropic key", () => {
    process.env.GROQ_API_KEY = "groq-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    expect(getAIProvider()).toBeInstanceOf(GroqClient);
  });

  it("falls back to Anthropic when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    expect(getAIProvider()).toBeInstanceOf(RealAnthropicClient);
  });

  it("caches the resolved provider until reset", () => {
    process.env.GROQ_API_KEY = "groq-test-key";
    const first = getAIProvider();
    process.env.GROQ_API_KEY = "different-key";
    expect(getAIProvider()).toBe(first);
    resetAIProvider();
    expect(getAIProvider()).not.toBe(first);
  });
});

describe("legacy wrappers", () => {
  it("setAnthropicClient registers a provider for getAnthropicClient", () => {
    const provider = new GroqClient("test");
    setAnthropicClient(provider);
    expect(getAnthropicClient()).toBe(provider);
  });

  it("setAIProvider(null) makes getAnthropicClient return null", () => {
    setAIProvider(null);
    expect(getAnthropicClient()).toBeNull();
  });
});

// ─── GroqClient request/response contract ────────────────────────────────────

describe("GroqClient.complete", () => {
  it("posts a chat-completions payload and returns the message content", async () => {
    const fetchMock = mockFetchResponse({
      choices: [{ message: { content: "review text" } }],
    });
    const client = new GroqClient("groq-test-key", "test-model");

    const result = await client.complete("user prompt", "system prompt");

    expect(result).toBe("review text");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer groq-test-key",
        "Content-Type": "application/json",
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "test-model",
      max_tokens: 1024,
      temperature: 0.2,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "user prompt" },
      ],
    });
  });

  it("throws RateLimitError on HTTP 429 so the orchestrator can retry", async () => {
    mockFetchResponse({ error: "slow down" }, 429);
    const client = new GroqClient("groq-test-key");
    await expect(client.complete("prompt", "system")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws on non-429 HTTP errors", async () => {
    mockFetchResponse({ error: "bad request" }, 400);
    const client = new GroqClient("groq-test-key");
    await expect(client.complete("prompt", "system")).rejects.toThrow("Groq API error 400");
  });

  it("throws when the response contains no text content", async () => {
    mockFetchResponse({ choices: [] });
    const client = new GroqClient("groq-test-key");
    await expect(client.complete("prompt", "system")).rejects.toThrow(
      "Groq API returned no text content.",
    );
  });
});

// ─── Legacy Anthropic client still works ─────────────────────────────────────

describe("RealAnthropicClient.complete", () => {
  it("parses the Messages API response shape", async () => {
    const fetchMock = mockFetchResponse({ content: [{ type: "text", text: "legacy ok" }] });
    const client = new RealAnthropicClient("anthropic-test-key");

    const result = await client.complete("prompt", "system");

    expect(result).toBe("legacy ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toEqual(expect.objectContaining({ "x-api-key": "anthropic-test-key" }));
  });
});
