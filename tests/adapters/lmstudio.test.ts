/**
 * LM Studio adapter conformance tests + focused unit tests.
 *
 * The conformance harness (run-conformance.ts) validates the shared contract; the
 * `describe` blocks below pin LM Studio-specific behaviour that the generic harness
 * does not assert on: operative context-window selection and cache-usage reporting.
 */

import { describe, it, expect } from "vitest";
import { runConformance } from "../conformance/run-conformance.ts";
import { lmstudioFixture } from "./lmstudio.fixture.ts";
import { lmstudioAdapter } from "../../src/adapters/lmstudio.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

runConformance([lmstudioFixture]);

const SERVER: DiscoveredServer = {
  kind: "lmstudio",
  baseUrl: "http://127.0.0.1:1234",
  auth: "none",
  label: "LM Studio (127.0.0.1:1234)",
  confidence: 0.95,
};

/** A models response where the loaded model was loaded with a window far below its max. */
const MODELS: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      // Loaded at 4096 even though the model ceiling is 131072.
      {
        id: "loaded-small-ctx",
        type: "llm",
        state: "loaded",
        compatibility_type: "gguf",
        max_context_length: 131072,
        loaded_context_length: 4096,
      },
      // Not loaded → loaded_context_length is 0; the ceiling must be used.
      {
        id: "unloaded",
        type: "llm",
        state: "not-loaded",
        compatibility_type: "gguf",
        max_context_length: 32768,
        loaded_context_length: 0,
      },
    ],
  },
};

describe("lmstudio context window", () => {
  it("registers the loaded (operative) context window, not the model ceiling", async () => {
    const models = await lmstudioAdapter.listModels(
      SERVER,
      { mode: "none" },
      createFakeProbe({ "/api/v1/models": MODELS }),
    );
    const loaded = models.find((m) => m.id === "loaded-small-ctx");
    expect(loaded?.contextWindow).toBe(4096);
    const entry = lmstudioAdapter.toPiModel(SERVER, loaded!);
    expect(entry.contextWindow).toBe(4096);
  });

  it("falls back to the model ceiling when the model is not loaded", async () => {
    const models = await lmstudioAdapter.listModels(
      SERVER,
      { mode: "none" },
      createFakeProbe({ "/api/v1/models": MODELS }),
    );
    const unloaded = models.find((m) => m.id === "unloaded");
    expect(unloaded?.contextWindow).toBe(32768);
  });
});

describe("lmstudio cache-hit reporting", () => {
  it("keeps usage-in-streaming on so cached_tokens are recorded, without anthropic cache markers", () => {
    const entry = lmstudioAdapter.toPiModel(SERVER, {
      id: "m",
      name: "m",
      input: ["text"],
      contextWindow: 8192,
    });
    // `compat` is a per-api union on the Pi type; LM Studio is openai-completions.
    const compat = entry.compat as
      | { supportsUsageInStreaming?: boolean; cacheControlFormat?: string }
      | undefined;
    expect(compat?.supportsUsageInStreaming).toBe(true);
    // Automatic prefix caching must NOT be driven by Anthropic-style markers.
    expect(compat?.cacheControlFormat).toBeUndefined();
  });
});
