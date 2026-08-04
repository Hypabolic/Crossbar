/**
 * Conformance tests for the oMLX backend adapter.
 *
 * Delegates entirely to the shared conformance harness — no adapter-specific
 * logic here. Add per-adapter edge cases below if needed.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { omlxFixture } from "./omlx.fixture.ts";
import { describe, it, expect } from "vitest";
import { genericAdapter } from "../../src/adapters/generic.ts";
import { omlxAdapter } from "../../src/adapters/omlx.ts";
import type { DiscoveredServer, Probe, ProbeResult } from "../../src/core/types.ts";

runConformance([omlxFixture]);

// ---------------------------------------------------------------------------
// Bug-proof tests: oMLX max_model_len must become contextWindow
// ---------------------------------------------------------------------------

describe("oMLX max_model_len → contextWindow", () => {
  // The value reported by oMLX in the bug report (issue #19)
  const REPORTED_MAX_MODEL_LEN = 65536;

  /** Simulate an oMLX /v1/models response with max_model_len. */
  function makeOmlxProbe(maxModelLen: number): Probe {
    return (): Promise<ProbeResult> =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          object: "list",
          data: [
            {
              id: "test-model",
              object: "model",
              created: 1784327392,
              owned_by: "omlx",
              max_model_len: maxModelLen,
            },
          ],
        },
      });
  }

  /** Simulate a generic /v1/models response (no max_model_len). */
  function makeGenericProbe(): Probe {
    return (): Promise<ProbeResult> =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          data: [{ id: "generic-model" }],
        },
      });
  }

  const omlxServer: DiscoveredServer = {
    kind: "omlx",
    baseUrl: "http://localhost:8000",
    auth: "apiKey",
    label: "oMLX",
    confidence: 1,
  };

  const genericServer: DiscoveredServer = {
    kind: "openai-generic",
    baseUrl: "http://localhost:8080",
    auth: "none",
    label: "OpenAI-compatible",
    confidence: 1,
  };

  it("oMLX adapter: contextWindow matches server's max_model_len", async () => {
    const models = await omlxAdapter.listModels(
      omlxServer,
      { mode: "apiKey", apiKey: "x" },
      makeOmlxProbe(REPORTED_MAX_MODEL_LEN),
    );
    expect(models.length).toBeGreaterThan(0);
    expect(models.at(0)!.contextWindow).toBe(REPORTED_MAX_MODEL_LEN);
  });

  it("generic adapter: contextWindow defaults to 8192 when no max_model_len", async () => {
    const models = await genericAdapter.listModels(
      genericServer,
      { mode: "none" },
      makeGenericProbe(),
    );
    expect(models.length).toBeGreaterThan(0);
    expect(models.at(0)!.contextWindow).toBe(8192);
  });
});

// ---------------------------------------------------------------------------
// Offline unit tests: thinking_default, status shape, aliases, health, filter
// ---------------------------------------------------------------------------

describe("oMLX thinking_default → reasoning (offline)", () => {
  const server: DiscoveredServer = {
    kind: "omlx",
    baseUrl: "http://127.0.0.1:8000",
    auth: "none",
    label: "oMLX",
    confidence: 1,
  };

  function makeProbe(routes: Record<string, ProbeResult>): Probe {
    return (path) => {
      const hit = routes[path];
      if (hit) return Promise.resolve(hit);
      return Promise.resolve({
        status: 0,
        ok: false,
        headers: {},
        error: `no route for ${path}`,
      });
    };
  }

  it("thinking_default:true → reasoning:true; false → reasoning:false", async () => {
    const probe = makeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          object: "list",
          data: [
            {
              id: "thinker",
              owned_by: "omlx",
              max_model_len: 65536,
            },
            {
              id: "plain",
              owned_by: "omlx",
              max_model_len: 8192,
            },
          ],
        },
      },
      "/v1/models/status": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          // status body with { models: [...] } (not only data)
          models: [
            {
              id: "thinker",
              loaded: true,
              thinking_default: true,
              model_type: "llm",
            },
            {
              id: "plain",
              loaded: false,
              thinking_default: false,
              model_type: "llm",
            },
          ],
        },
      },
    });

    const models = await omlxAdapter.listModels(server, { mode: "none" }, probe);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["thinker"]?.reasoning).toBe(true);
    expect(byId["plain"]?.reasoning).toBe(false);
  });

  it("status body with models[] drives introspectLoaded loaded ids", async () => {
    const probe = makeProbe({
      "/v1/models/status": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          models: [
            { id: "phys-a", model_alias: "alias-a", loaded: true, actual_size: 100 },
            { id: "phys-b", model_alias: "alias-b", loaded: false },
          ],
        },
      },
    });

    const state = await omlxAdapter.introspectLoaded!(server, { mode: "none" }, probe);
    expect(state.source).toBe("introspection");
    // Prefer alias when present; also include physical when distinct.
    expect(state.loadedModelIds).toContain("alias-a");
    expect(state.loadedModelIds).toContain("phys-a");
    expect(state.loadedModelIds).not.toContain("alias-b");
    expect(state.perModel).toBeDefined();
    expect(state.perModel?.["alias-a"]?.vramBytes).toBe(100);
  });

  it("resolves listModels alias id against status physical id for thinking", async () => {
    const probe = makeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          data: [
            {
              // list may expose the alias as id
              id: "friendly-name",
              owned_by: "omlx",
              max_model_len: 32768,
            },
          ],
        },
      },
      "/v1/models/status": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          models: [
            {
              id: "mlx-community/Some-Model-4bit",
              model_alias: "friendly-name",
              loaded: true,
              thinking_default: true,
              model_type: "llm",
            },
          ],
        },
      },
    });

    const models = await omlxAdapter.listModels(server, { mode: "none" }, probe);
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("friendly-name");
    expect(models[0]!.reasoning).toBe(true);
  });

  it("switchModel confirms load when status uses physical id and caller used alias", async () => {
    const calls: string[] = [];
    const probe: Probe = (path) => {
      calls.push(path);
      if (path === "/v1/models/status") {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: {},
          json: {
            models: [
              {
                id: "phys-dir",
                model_alias: "my-alias",
                loaded: true,
                thinking_default: false,
              },
            ],
          },
        });
      }
      if (path === "/v1/models/phys-dir/load") {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: {},
          json: { status: "ok" },
        });
      }
      return Promise.resolve({ status: 0, ok: false, headers: {}, error: path });
    };

    await expect(
      omlxAdapter.switchModel!(server, { mode: "none" }, "my-alias", probe),
    ).resolves.toBeUndefined();
    expect(calls.some((c) => c.includes("/v1/models/phys-dir/load"))).toBe(true);
  });

  it("marks embedding/reranker models with embeddings:true", async () => {
    const probe = makeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: {},
        json: {
          data: [
            { id: "chat-model", owned_by: "omlx", max_model_len: 8192 },
            { id: "bge-m3-embed", owned_by: "omlx", max_model_len: 8192 },
            { id: "reranker-v1", owned_by: "omlx", max_model_len: 8192 },
            { id: "typed-embed", owned_by: "omlx", max_model_len: 8192 },
          ],
        },
      },
      "/v1/models/status": {
        status: 200,
        ok: true,
        headers: {},
        json: {
          models: [
            { id: "chat-model", loaded: true, model_type: "llm", thinking_default: false },
            { id: "bge-m3-embed", loaded: false, model_type: "embedding" },
            { id: "reranker-v1", loaded: false, engine_type: "reranker" },
            { id: "typed-embed", loaded: false, model_type: "embedding", engine_type: "embed" },
          ],
        },
      },
    });

    const models = await omlxAdapter.listModels(server, { mode: "none" }, probe);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["chat-model"]?.embeddings).toBe(false);
    expect(byId["bge-m3-embed"]?.embeddings).toBe(true);
    expect(byId["reranker-v1"]?.embeddings).toBe(true);
    expect(byId["typed-embed"]?.embeddings).toBe(true);
  });

  it("health 503 → loading (not degraded)", async () => {
    const probe = makeProbe({
      "/health": {
        status: 503,
        ok: false,
        headers: {},
        json: { status: "loading" },
      },
    });
    const h = await omlxAdapter.health!(server, { mode: "none" }, probe);
    expect(h.state).toBe("loading");
  });

  it("introspectLoaded omits perModel when no loaded models (exactOptionalPropertyTypes)", async () => {
    const probe = makeProbe({
      "/v1/models/status": {
        status: 200,
        ok: true,
        headers: {},
        json: {
          data: [{ id: "idle", loaded: false }],
        },
      },
    });
    const state = await omlxAdapter.introspectLoaded!(server, { mode: "none" }, probe);
    expect(state.loadedModelIds).toEqual([]);
    expect(state.perModel).toBeUndefined();
    expect(state.source).toBe("introspection");
  });
});
