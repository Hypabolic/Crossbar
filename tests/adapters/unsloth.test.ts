/**
 * Conformance tests for the Unsloth Studio backend adapter.
 *
 * Delegates the standard contract checks to the shared conformance harness, then adds
 * adapter-specific coverage for the discriminator that actually motivated this adapter:
 * identifying Unsloth Studio from its `Server: unsloth-studio` response header even when no
 * working API key is in hand yet, and declaring `authRequired` so onboarding can't offer a
 * "No authentication" option for it.
 */

import { describe, it, expect } from "vitest";

import { runConformance } from "../conformance/run-conformance.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { unslothAdapter } from "../../src/adapters/unsloth.ts";
import { unslothFixture } from "./unsloth.fixture.ts";

runConformance([unslothFixture]);

describe("[unsloth] adapter-specific", () => {
  it("declares authRequired — this backend has no unauthenticated mode", () => {
    expect(unslothAdapter.authRequired).toBe(true);
  });

  it("identifies the server from the Server header alone, even on an unauthenticated 401", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 401,
        ok: false,
        headers: { server: "unsloth-studio", "www-authenticate": "Bearer" },
        json: { error: { message: "Not authenticated", type: "authentication_error" } },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("unsloth");
    expect(result?.auth).toBe("apiKey");
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  it("matches the Server header value case-insensitively", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 401,
        ok: false,
        headers: { server: "Unsloth-Studio" },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result?.kind).toBe("unsloth");
  });

  it("does NOT claim a 401 from a different backend lacking the Server header", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 401,
        ok: false,
        headers: { "content-type": "application/json" },
        json: { error: "Unauthorized" },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).toBeNull();
  });

  it("does NOT claim a 200 + data[] response lacking the Server header, no matter how plausible", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: { object: "list", data: [{ id: "totally-plausible-model", owned_by: "unsloth-studio" }] },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).toBeNull();
  });

  it("returns null on connection refused (status 0)", async () => {
    const probe = createFakeProbe({});
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).toBeNull();
  });

  it("introspectLoaded reports only models with loaded: true", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: { server: "unsloth-studio" },
        json: {
          data: [
            { id: "a", owned_by: "unsloth-studio", loaded: true },
            { id: "b", owned_by: "unsloth-studio", loaded: false },
          ],
        },
      },
    });
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    const result = await unslothAdapter.introspectLoaded?.(server, { mode: "apiKey", apiKey: "k" }, probe);
    expect(result?.loadedModelIds).toEqual(["a"]);
    expect(result?.source).toBe("introspection");
  });

  // Regression: the adapter used to fabricate contextWindow 8192 / maxTokens 4096 for any
  // model without context fields. Captured verbatim from a live instance: Unsloth Studio
  // emits the *context_length fields ONLY for the currently-loaded model, so EVERY unloaded
  // entry got a bogus "8k ctx" — shown in the picker and frozen into crossbar.json's
  // lastKnownModels — even for models with a real 262144-token context.
  describe("context window reporting", () => {
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    const cred = { mode: "apiKey" as const, apiKey: "k" };

    const probeFor = (entries: unknown[]) =>
      createFakeProbe({
        "/v1/models": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { data: entries },
        },
      });

    it("omits contextWindow entirely when the server reports no context fields", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        probeFor([{ id: "unloaded", owned_by: "unsloth-studio", loaded: false }]),
      );
      expect(models).toHaveLength(1);
      expect(models[0]).not.toHaveProperty("contextWindow");
      expect(models[0]).not.toHaveProperty("maxTokens");
    });

    it("reports the real context of a loaded model verbatim", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        probeFor([
          {
            id: "Qwen3.6-35B-A3B-UD-Q4_K_M",
            owned_by: "unsloth-studio",
            loaded: true,
            context_length: 262144,
            max_context_length: 262144,
            native_context_length: 262144,
          },
        ]),
      );
      expect(models[0]?.contextWindow).toBe(262144);
    });

    it("falls back to max/native context when the configured one is absent or zero", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        probeFor([
          { id: "max-only", owned_by: "unsloth-studio", max_context_length: 229888 },
          { id: "native-only", owned_by: "unsloth-studio", context_length: 0, native_context_length: 262144 },
        ]),
      );
      expect(models[0]?.contextWindow).toBe(229888);
      expect(models[1]?.contextWindow).toBe(262144);
    });

    it("maps an unknown context to Pi's 128k fallback and unbounded maxTokens, never 8192", () => {
      const entry = unslothAdapter.toPiModel(server, {
        id: "unloaded",
        name: "unloaded",
        input: ["text"],
      });
      expect(entry.contextWindow).toBe(128_000);
      expect(entry.maxTokens).toBe(0);
    });

    it("passes a known context through to the Pi entry untouched", () => {
      const entry = unslothAdapter.toPiModel(server, {
        id: "loaded",
        name: "loaded",
        input: ["text"],
        contextWindow: 262144,
      });
      expect(entry.contextWindow).toBe(262144);
    });
  });

  it("inferenceBaseUrl appends /v1 exactly once", () => {
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    expect(unslothAdapter.inferenceBaseUrl(server)).toBe("http://127.0.0.1:8888/v1");
    expect(unslothAdapter.inferenceBaseUrl({ ...server, baseUrl: "http://127.0.0.1:8888/v1" })).toBe(
      "http://127.0.0.1:8888/v1",
    );
  });
});
