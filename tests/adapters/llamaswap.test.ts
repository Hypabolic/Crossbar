/**
 * Conformance test for the llama-swap adapter.
 */

import { describe, expect, it } from "vitest";

import { llamaswapAdapter } from "../../src/adapters/llamaswap.ts";
import type { DiscoveredServer, Probe, ProbeInit } from "../../src/core/types.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { runConformance } from "../conformance/run-conformance.ts";
import { llamaswapFixture } from "./llamaswap.fixture.ts";

runConformance([llamaswapFixture]);

const SERVER: DiscoveredServer = {
  kind: "llamaswap",
  baseUrl: "http://127.0.0.1:8080",
  auth: "none",
  label: "llama-swap",
  confidence: 0.9,
};

function modelsProbe(data: unknown[]): { probe: Probe; paths: string[] } {
  const paths: string[] = [];
  const fakeProbe = createFakeProbe({
    "/v1/models": {
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      json: { data },
    },
  });
  const probe = async (path: string, init?: ProbeInit) => {
    paths.push(path);
    return fakeProbe(path, init);
  };
  return { probe, paths };
}

describe("llamaswap model limits", () => {
  it("keeps a positive safe top-level context_length without inventing maxTokens", async () => {
    const { probe, paths } = modelsProbe([
      {
        id: "configured-context",
        context_length: 32_768,
        meta: null,
      },
    ]);

    const models = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models).toHaveLength(1);
    expect(models[0]?.contextWindow).toBe(32_768);
    expect(models[0]).not.toHaveProperty("maxTokens");
    expect(paths).toEqual(["/v1/models"]);
  });

  it("omits missing, non-positive, and invalid context_length values", async () => {
    const { probe } = modelsProbe([
      { id: "missing" },
      { id: "null", context_length: null },
      { id: "zero", context_length: 0 },
      { id: "negative", context_length: -1 },
      { id: "fractional", context_length: 4096.5 },
      { id: "unsafe", context_length: Number.MAX_SAFE_INTEGER + 1 },
      { id: "string", context_length: "8192" },
    ]);

    const models = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models.map((model) => model.id)).toEqual([
      "missing",
      "null",
      "zero",
      "negative",
      "fractional",
      "unsafe",
      "string",
    ]);
    for (const model of models) {
      expect(model).not.toHaveProperty("contextWindow");
      expect(model).not.toHaveProperty("maxTokens");
    }
  });

  it("ignores context- and output-looking values in arbitrary llama-swap metadata", async () => {
    const { probe, paths } = modelsProbe([
      {
        id: "metadata-only",
        meta: {
          llamaswap: {
            context_length: 65_536,
            contextWindow: 65_536,
            max_tokens: 4096,
            maxTokens: 4096,
            n_predict: 4096,
          },
        },
      },
    ]);

    const models = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models[0]).not.toHaveProperty("contextWindow");
    expect(models[0]).not.toHaveProperty("maxTokens");
    expect(paths).toEqual(["/v1/models"]);
  });
});

describe("llamaswap Pi model limits", () => {
  it("uses only the 128000/0 registration fallback when limits are missing", () => {
    const piModel = llamaswapAdapter.toPiModel(SERVER, {
      id: "unknown-limits",
      name: "unknown-limits",
      input: ["text"],
    });

    expect(piModel.contextWindow).toBe(128_000);
    expect(piModel.maxTokens).toBe(0);
  });

  it("uses the registration fallback for non-positive limits", () => {
    const piModel = llamaswapAdapter.toPiModel(SERVER, {
      id: "non-positive-limits",
      name: "non-positive-limits",
      input: ["text"],
      contextWindow: 0,
      maxTokens: -1,
    });

    expect(piModel.contextWindow).toBe(128_000);
    expect(piModel.maxTokens).toBe(0);
  });

  it("passes through positive descriptor limits exactly", () => {
    const piModel = llamaswapAdapter.toPiModel(SERVER, {
      id: "known-limits",
      name: "known-limits",
      input: ["text"],
      contextWindow: 65_536,
      maxTokens: 3072,
    });

    expect(piModel.contextWindow).toBe(65_536);
    expect(piModel.maxTokens).toBe(3072);
  });
});
