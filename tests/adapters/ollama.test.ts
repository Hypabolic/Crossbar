import { describe, expect, it } from "vitest";
import { runConformance } from "../conformance/run-conformance.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { ollamaAdapter } from "../../src/adapters/ollama.ts";
import { ollamaFixture } from "./ollama.fixture.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

runConformance([ollamaFixture]);

/**
 * Window provenance: Ollama's model_info `*.context_length` is the model FILE's trained
 * context — a trained ceiling the server does not commit to serving. It must surface as
 * informational `trainedMax` only; the serviceable window stays unknown and the Pi
 * boundary gets the uniform 8192 fallback.
 */
describe("ollama window provenance", () => {
  const server: DiscoveredServer = {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    auth: "none",
    label: "Ollama",
    confidence: 0.95,
  };

  const ok = (json: unknown): ProbeResult => ({
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json,
  });

  it("maps model_info context_length to trainedMax, never to the registered window", async () => {
    const probe = createFakeProbe({
      "/api/tags": ok({ models: [{ name: "qwen2.5:7b", model: "qwen2.5:7b" }] }),
      "POST /api/show": () =>
        ok({
          capabilities: ["tools"],
          model_info: { "qwen2mlp.context_length": 32768 },
        }),
    });

    const models = await ollamaAdapter.listModels(server, { mode: "none" }, probe);
    expect(models).toHaveLength(1);
    expect(models[0]).not.toHaveProperty("contextWindow");
    expect(models[0]).not.toHaveProperty("contextWindowSource");
    expect(models[0]?.trainedMax).toBe(32768);
    expect(ollamaAdapter.toPiModel(server, models[0]!).contextWindow).toBe(8192);
  });
});
