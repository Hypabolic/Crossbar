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
