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
import { createFakeProbe, type RouteMap } from "../conformance/fake-probe.ts";
import { unslothAdapter } from "../../src/adapters/unsloth.ts";
import { unslothFixture } from "./unsloth.fixture.ts";
import { Capability } from "../../src/core/capability.ts";
import type { Probe } from "../../src/core/types.ts";

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

  // Regression (issue #35): the adapter used to hardcode input: ["text"] for every model
  // because /v1/models carries no modality info — Pi then silently replaced attached images
  // with "(image omitted: model does not support images)", so VLMs appeared to have no vision.
  describe("vision detection (issue #35)", () => {
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    const cred = { mode: "apiKey" as const, apiKey: "sk-unsloth-test-key" };

    // Vision is probed ONLY for loaded models (unloaded ones would make Studio hit HF), so
    // every model under test here is marked loaded to exercise the probe path.
    // Vision comes from /api/inference/status (the loaded backend), NOT from a per-model
    // check-vision probe (which would make Studio hit huggingface.co). The status endpoint
    // describes exactly one loaded model, matched by active_model.
    const visionProbe = (id: string, isVision: boolean) =>
      createFakeProbe({
        "/v1/models": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { data: [{ id, owned_by: "unsloth-studio", loaded: true }] },
        },
        "/api/inference/status": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { active_model: id, is_vision: isVision },
        },
      });

    it("registers a model as [text, image] when status reports is_vision: true", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        visionProbe("unsloth/Qwen2.5-VL-7B-Instruct-GGUF", true),
      );
      expect(models).toHaveLength(1);
      expect(models[0]?.input).toEqual(["text", "image"]);
    });

    it("keeps text models at [text] when status reports is_vision: false", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        visionProbe("unsloth/Qwen3.8-27B-GGUF", false),
      );
      expect(models[0]?.input).toEqual(["text"]);
    });

    it("passes the image modality through toPiModel", () => {
      const entry = unslothAdapter.toPiModel(server, {
        id: "vlm",
        name: "vlm",
        input: ["text", "image"],
      });
      expect(entry.input).toEqual(["text", "image"]);
    });

    it("does NOT probe unloaded models — they stay text-only even if the backend is a VLM", async () => {
      const requestedPaths: string[] = [];
      const probe: Probe = async (path) => {
        requestedPaths.push(path);
        if (path === "/v1/models") {
          return {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: { data: [{ id: "unloaded-vlm", owned_by: "unsloth-studio", loaded: false }] },
          };
        }
        // If this were ever hit it would report a VLM — the test asserts check-vision is NOT hit
        // and that status names a DIFFERENT (loaded) model, so the unloaded one stays text-only.
        if (path === "/api/inference/status") {
          return {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: { active_model: "some-other-loaded-model", is_vision: true },
          };
        }
        return { status: 0, ok: false, headers: {}, json: null };
      };
      const models = await unslothAdapter.listModels(server, cred, probe);
      expect(models[0]?.input).toEqual(["text"]);
      // The whole point of the fix: no check-vision request at all (no HF hit).
      expect(requestedPaths.some((p) => p.startsWith("/api/models/check-vision/"))).toBe(false);
    });

    it("degrades to [text] when the status endpoint is missing (older Studio → status 0)", async () => {
      const probe = createFakeProbe({
        "/v1/models": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { data: [{ id: "some-vlm", owned_by: "unsloth-studio", loaded: true }] },
        },
      }); // no /api/inference/status fixture → refused connection
      const models = await unslothAdapter.listModels(server, cred, probe);
      expect(models[0]?.input).toEqual(["text"]);
    });

    it("degrades to [text] on 401 / non-200 / malformed bodies — never throws", async () => {
      for (const json of [
        { active_model: "m", is_vision: "yes" }, // not a boolean
        { active_model: "m", other: true },
        undefined,
      ]) {
        const probe = createFakeProbe({
          "/v1/models": {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: { data: [{ id: "m", owned_by: "unsloth-studio", loaded: true }] },
          },
          "/api/inference/status":
            json === undefined
              ? { status: 401, ok: false, headers: { server: "unsloth-studio" }, json: null }
              : { status: 200, ok: true, headers: { server: "unsloth-studio" }, json },
        });
        const models = await unslothAdapter.listModels(server, cred, probe);
        expect(models[0]?.input).toEqual(["text"]);
      }
    });

    it("reads vision from /api/inference/status and sends the bearer key — never check-vision", async () => {
      const seenPaths: string[] = [];
      let statusHeaders: Record<string, string> | undefined;
      const probe: Probe = async (path, init) => {
        seenPaths.push(path);
        if (path === "/v1/models") {
          return {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: {
              data: [{ id: "unsloth/Qwen2.5-VL-7B-Instruct-GGUF", owned_by: "unsloth-studio", loaded: true }],
            },
          };
        }
        statusHeaders = init?.headers;
        return {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { active_model: "unsloth/Qwen2.5-VL-7B-Instruct-GGUF", is_vision: true },
        };
      };
      const models = await unslothAdapter.listModels(server, cred, probe);
      expect(seenPaths).toContain("/api/inference/status");
      expect(seenPaths.some((p) => p.startsWith("/api/models/check-vision/"))).toBe(false);
      expect(statusHeaders?.["Authorization"]).toBe("Bearer sk-unsloth-test-key");
      expect(models[0]?.input).toEqual(["text", "image"]);
    });
  });

  // Regression (issue #37): the adapter used to hardcode reasoning: false for every model.
  // Studio exposes thinking metadata only for the LOADED model, via GET /api/inference/status
  // (supports_reasoning + active_model carrying the same public id as /v1/models).
  describe("thinking detection (issue #37)", () => {
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    const cred = { mode: "apiKey" as const, apiKey: "sk-unsloth-test-key" };

    const thinkingProbe = (statusJson: unknown) =>
      createFakeProbe({
        "/v1/models": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: {
            data: [
              { id: "thinker", owned_by: "unsloth-studio", loaded: true },
              { id: "plain", owned_by: "unsloth-studio", loaded: false },
            ],
          },
        },
        "/api/inference/status": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: statusJson,
        },
      });

    it("registers the loaded model as reasoning-capable, matched by active_model", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        thinkingProbe({ active_model: "thinker", supports_reasoning: true }),
      );
      expect(models.find((m) => m.id === "thinker")?.reasoning).toBe(true);
      expect(models.find((m) => m.id === "plain")?.reasoning).toBe(false);
    });

    it("falls back to the loaded entry when active_model is absent", async () => {
      const models = await unslothAdapter.listModels(
        server,
        cred,
        thinkingProbe({ supports_reasoning: true }),
      );
      expect(models.find((m) => m.id === "thinker")?.reasoning).toBe(true);
      expect(models.find((m) => m.id === "plain")?.reasoning).toBe(false);
    });

    it("applies nothing when supports_reasoning is false or malformed", async () => {
      for (const json of [{ active_model: "thinker", supports_reasoning: false }, { supports_reasoning: "yes" }]) {
        const models = await unslothAdapter.listModels(server, cred, thinkingProbe(json));
        expect(models.every((m) => m.reasoning === false)).toBe(true);
      }
    });

    it("degrades to all-false when the endpoint is missing (older Studio) or fails — never throws", async () => {
      // No /api/inference/status fixture → refused connection (status 0).
      const probe = createFakeProbe({
        "/v1/models": {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { data: [{ id: "thinker", owned_by: "unsloth-studio", loaded: true }] },
        },
      });
      const models = await unslothAdapter.listModels(server, cred, probe);
      expect(models[0]?.reasoning).toBe(false);

      for (const status of [401, 404] as const) {
        const failingProbe = createFakeProbe({
          "/v1/models": {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: { data: [{ id: "thinker", owned_by: "unsloth-studio", loaded: true }] },
          },
          "/api/inference/status": {
            status,
            ok: false,
            headers: { server: "unsloth-studio" },
            json: null,
          },
        });
        const failingModels = await unslothAdapter.listModels(server, cred, failingProbe);
        expect(failingModels[0]?.reasoning).toBe(false);
      }
    });

    it("sends the bearer key with the status request", async () => {
      let seenHeaders: Record<string, string> | undefined;
      const probe: Probe = async (path, init) => {
        if (path === "/v1/models") {
          return {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: { data: [{ id: "thinker", owned_by: "unsloth-studio", loaded: true }] },
          };
        }
        seenHeaders = init?.headers;
        return {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { active_model: "thinker", supports_reasoning: true },
        };
      };
      const models = await unslothAdapter.listModels(server, cred, probe);
      expect(seenHeaders?.["Authorization"]).toBe("Bearer sk-unsloth-test-key");
      expect(models[0]?.reasoning).toBe(true);
    });

    it("passes reasoning through toPiModel", () => {
      const entry = unslothAdapter.toPiModel(server, {
        id: "thinker",
        name: "thinker",
        input: ["text"],
        reasoning: true,
      });
      expect(entry.reasoning).toBe(true);
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

  describe("autoLoadsOnDemand (\"Switch model by request\")", () => {
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    const cred = { mode: "apiKey" as const, apiKey: "sk-unsloth-test-key" };

    const settingsRoute = (enabled: unknown) => ({
      "/api/settings/openai-auto-switch": {
        status: 200,
        ok: true,
        headers: { server: "unsloth-studio", "content-type": "application/json" },
        json: { enabled, auto_unload_idle_seconds: 0 },
      },
    });

    it("declares the AutoLoadStatus capability", () => {
      expect(unslothAdapter.capabilities.has(Capability.AutoLoadStatus)).toBe(true);
    });

    it("returns false when the toggle is off (unloaded models 404 until loaded in the UI)", async () => {
      const probe = createFakeProbe(settingsRoute(false));
      const result = await unslothAdapter.autoLoadsOnDemand!(server, cred, probe);
      expect(result).toBe(false);
    });

    it("returns true when the toggle is on (unloaded models are served on demand)", async () => {
      const probe = createFakeProbe(settingsRoute(true));
      const result = await unslothAdapter.autoLoadsOnDemand!(server, cred, probe);
      expect(result).toBe(true);
    });

    it("sends the bearer key with the settings request", async () => {
      let seenHeaders: Record<string, string> | undefined;
      const probe: Probe = async (_path, init) => {
        seenHeaders = init?.headers;
        return {
          status: 200,
          ok: true,
          headers: { server: "unsloth-studio" },
          json: { enabled: false },
        };
      };
      await unslothAdapter.autoLoadsOnDemand!(server, cred, probe);
      expect(seenHeaders?.["Authorization"]).toBe("Bearer sk-unsloth-test-key");
    });

    it("returns undefined (not a throw) when the endpoint is missing — old server versions", async () => {
      const probe = createFakeProbe({}); // no fixture → status 0
      const result = await unslothAdapter.autoLoadsOnDemand!(server, cred, probe);
      expect(result).toBeUndefined();
    });

    it("returns undefined on 401 (invalid key)", async () => {
      const probe = createFakeProbe({
        "/api/settings/openai-auto-switch": {
          status: 401,
          ok: false,
          headers: { server: "unsloth-studio" },
          json: { error: { message: "Not authenticated", type: "authentication_error" } },
        },
      });
      const result = await unslothAdapter.autoLoadsOnDemand!(server, cred, probe);
      expect(result).toBeUndefined();
    });

    it("returns undefined when the body is malformed or `enabled` is not a boolean", async () => {
      for (const body of [undefined, { enabled: "yes" }, { enabled: 0 }, { other: true }]) {
        const probe = createFakeProbe({
          "/api/settings/openai-auto-switch": {
            status: 200,
            ok: true,
            headers: { server: "unsloth-studio" },
            json: body,
          },
        });
        const result = await unslothAdapter.autoLoadsOnDemand!(server, cred, probe);
        expect(result).toBeUndefined();
      }
    });
  });
});
