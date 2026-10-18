/**
 * Conformance test for the generic OpenAI-compatible adapter.
 *
 * Runs the full parameterised harness against genericFixture.
 * No adapter-specific logic here — all assertions live in run-conformance.ts.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { genericFixture } from "./generic.fixture.ts";
import { describe, expect, it } from "vitest";
import { genericAdapter } from "../../src/adapters/generic.ts";
import type { DiscoveredServer, Probe } from "../../src/core/types.ts";

runConformance([genericFixture]);

describe("generic embedding-model detection", () => {
  it("excludes common embedding and reranking model families from chat", async () => {
    const ids = [
      "bge-m3",
      "gte-large-en-v1.5",
      "e5-mistral-7b-instruct",
      "nomic-embed-text-v1.5",
      "jina-reranker-v2-base-multilingual",
      "chat-model",
    ];
    const probe: Probe = async () => ({
      status: 200,
      ok: true,
      headers: {},
      json: { data: ids.map((id) => ({ id })) },
    });
    const server: DiscoveredServer = {
      kind: "openai-generic",
      baseUrl: "http://localhost:8080",
      auth: "none",
      label: "Generic",
      confidence: 1,
    };

    const models = await genericAdapter.listModels(server, { mode: "none" }, probe);

    expect(models.filter((model) => model.embeddings).map((model) => model.id))
      .toEqual(ids.slice(0, 5));
    expect(models.find((model) => model.id === "chat-model")?.embeddings).toBe(false);
  });
});

const SERVER: DiscoveredServer = {
  kind: "openai-generic",
  baseUrl: "http://127.0.0.1:8080",
  auth: "none",
  label: "generic",
  confidence: 0.3,
};

function modelsProbe(data: unknown[]): Probe {
  return async () => ({
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json: { data },
  });
}

describe("generic context window detection", () => {
  it("reads Lemonade's max_context_window when no earlier key is present", async () => {
    const probe = modelsProbe([
      {
        id: "Qwen3.6-27B-MTP-GGUF-Q8_0",
        max_context_window: 262144,
        recipe: "llamacpp",
      },
    ]);

    const [model] = await genericAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxTokens).toBe(131072);
    expect(genericAdapter.toPiModel(SERVER, model!).contextWindow).toBe(262144);
  });

  it.each([
    ["context_window", { context_window: 1000, max_context_window: 262144 }, 1000],
    ["max_model_len", { max_model_len: 2000, max_context_window: 262144 }, 2000],
    ["context_length", { context_length: 3000, max_context_window: 262144 }, 3000],
    ["max_context_length", { max_context_length: 4000, max_context_window: 262144 }, 4000],
  ] as const)("prefers %s over max_context_window", async (_key, fields, expected) => {
    const probe = modelsProbe([{ id: "ranked", ...fields }]);

    const [model] = await genericAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.contextWindow).toBe(expected);
  });

  it("ignores a non-positive max_context_window and keeps the default", async () => {
    const probe = modelsProbe([
      { id: "zero", max_context_window: 0 },
      { id: "negative", max_context_window: -1 },
      { id: "absent" },
    ]);

    const models = await genericAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models.map((model) => model.contextWindow)).toEqual([8192, 8192, 8192]);
  });
});
