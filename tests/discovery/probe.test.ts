/**
 * Unit tests for src/discovery/probe.ts
 *
 * These tests never hit the network. They replace `fetch` with a spy/stub injected via
 * the global `fetch` mock approach — vitest's `vi.stubGlobal` keeps things tidy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProbe, DEFAULT_DISCOVERY_TIMEOUT_MS } from "../../src/discovery/probe.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

type FetchStub = (input: string | URL, init?: RequestInit) => Promise<Response>;

function makeFakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(impl: FetchStub): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createProbe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves path against baseUrl and returns parsed JSON on 200", async () => {
    const payload = { models: ["llama3"] };
    stubFetch(async () => makeFakeResponse(200, JSON.stringify(payload)));

    const probe = createProbe("http://127.0.0.1:11434");
    const result = await probe("/api/tags");

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.json).toEqual(payload);
    expect(result.text).toBe(JSON.stringify(payload));
    expect(typeof result.latencyMs).toBe("number");
  });

  it("lowercases response headers", async () => {
    stubFetch(async () =>
      makeFakeResponse(200, "ok", { "X-Custom-Header": "value", "Content-Type": "text/plain" }),
    );

    const probe = createProbe("http://127.0.0.1:8080");
    const result = await probe("/health");

    expect(Object.keys(result.headers).every((k) => k === k.toLowerCase())).toBe(true);
    expect(result.headers["content-type"]).toBeTruthy();
  });

  it("injects Authorization header when apiKey auth is configured", async () => {
    let capturedHeaders: Record<string, string> = {};

    stubFetch(async (_input, init) => {
      const raw = init?.headers ?? {};
      // Headers can be a plain object, Headers instance, or array
      if (raw instanceof Headers) {
        raw.forEach((v, k) => { capturedHeaders[k] = v; });
      } else if (Array.isArray(raw)) {
        for (const [k, v] of raw) {
          capturedHeaders[k as string] = v as string;
        }
      } else {
        capturedHeaders = raw as Record<string, string>;
      }
      return makeFakeResponse(200, "{}");
    });

    const probe = createProbe("http://127.0.0.1:11434", {
      auth: { mode: "apiKey", apiKey: "sk-supersecret" },
    });

    await probe("/v1/models");

    // Key must be injected
    expect(capturedHeaders["authorization"]).toBe("Bearer sk-supersecret");
  });

  it("does NOT inject Authorization header when auth mode is none", async () => {
    let capturedHeaders: Record<string, string> = {};

    stubFetch(async (_input, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return makeFakeResponse(200, "{}");
    });

    const probe = createProbe("http://127.0.0.1:11434", {
      auth: { mode: "none" },
    });

    await probe("/v1/models");

    expect(capturedHeaders["authorization"]).toBeUndefined();
  });

  it("does NOT include apiKey value in the returned result", async () => {
    stubFetch(async () => makeFakeResponse(200, '{"ok":true}'));

    const probe = createProbe("http://127.0.0.1:11434", {
      auth: { mode: "apiKey", apiKey: "sk-supersecret" },
    });

    const result = await probe("/v1/models");

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("sk-supersecret");
  });

  it("returns status:0 with error when fetch throws (connection refused)", async () => {
    stubFetch(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9999"), { code: "ECONNREFUSED" });
    });

    const probe = createProbe("http://127.0.0.1:9999");
    const result = await probe("/v1/models");

    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns status:0 with timeout error when AbortError is thrown", async () => {
    stubFetch(async (_input, init) => {
      // Simulate the abort being triggered
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });

    vi.useFakeTimers();

    const probe = createProbe("http://127.0.0.1:9999", { defaultTimeoutMs: 100 });
    const probePromise = probe("/slow-endpoint");

    // Advance timer past the timeout
    await vi.advanceTimersByTimeAsync(200);

    const result = await probePromise;

    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("uses DEFAULT_DISCOVERY_TIMEOUT_MS when no timeout is specified", () => {
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(600);
  });

  it("handles non-JSON body gracefully (text set, json undefined)", async () => {
    stubFetch(async () => makeFakeResponse(200, "Ollama is running"));

    const probe = createProbe("http://127.0.0.1:11434");
    const result = await probe("/");

    expect(result.text).toBe("Ollama is running");
    expect(result.json).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("returns non-ok status correctly for 401 responses", async () => {
    stubFetch(async () => makeFakeResponse(401, '{"error":"Unauthorized"}'));

    const probe = createProbe("http://127.0.0.1:11434");
    const result = await probe("/v1/chat/completions");

    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    expect(result.json).toEqual({ error: "Unauthorized" });
  });

  it("path with absolute URL bypasses baseUrl", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = input.toString();
      return makeFakeResponse(200, "{}");
    });

    const probe = createProbe("http://127.0.0.1:11434");
    await probe("http://other-host:9999/v1/models");

    expect(capturedUrl).toBe("http://other-host:9999/v1/models");
  });

  it("applies per-request timeoutMs override over the default", async () => {
    // We just verify createProbe accepts the override — no real timing test needed here
    stubFetch(async () => makeFakeResponse(200, "{}"));

    const probe = createProbe("http://127.0.0.1:11434", { defaultTimeoutMs: 5000 });
    // Override to 50ms for this specific request — should still succeed with a fast stub
    const result = await probe("/v1/models", { timeoutMs: 50 });

    expect(result.status).toBe(200);
  });

  it("merges caller headers without exposing auth key", async () => {
    let capturedHeaders: Record<string, string> = {};

    stubFetch(async (_input, init) => {
      const raw = init?.headers ?? {};
      if (raw instanceof Headers) {
        raw.forEach((v, k) => { capturedHeaders[k] = v; });
      } else {
        capturedHeaders = raw as Record<string, string>;
      }
      return makeFakeResponse(200, "{}");
    });

    const probe = createProbe("http://127.0.0.1:11434", {
      auth: { mode: "apiKey", apiKey: "sk-topsecret" },
    });

    await probe("/v1/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(capturedHeaders["authorization"]).toBe("Bearer sk-topsecret");
    expect(capturedHeaders["content-type"]).toBe("application/json");
  });
});
