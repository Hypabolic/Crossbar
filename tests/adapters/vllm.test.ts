/**
 * Conformance tests for the vLLM backend adapter.
 *
 * Delegates entirely to the shared conformance harness — no adapter-specific
 * logic here. Add per-adapter edge cases below if needed.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { vllmFixture } from "./vllm.fixture.ts";

runConformance([vllmFixture]);

import { describe, expect, it } from "vitest";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { vllmAdapter } from "../../src/adapters/vllm.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

describe("vllm window provenance", () => {
  const server: DiscoveredServer = {
    kind: "vllm",
    baseUrl: "http://127.0.0.1:8000",
    auth: "none",
    label: "vLLM",
    confidence: 0.9,
  };

  it("reports max_model_len as an observed window and none when the card omits it", async () => {
    const ok = (json: unknown): ProbeResult => ({
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      json,
    });
    const withLen = await vllmAdapter.listModels(server, { mode: "none" },
      createFakeProbe({ "/v1/models": ok({ data: [{ id: "m1", max_model_len: 40960 }] }) }),
    );
    expect(withLen[0]?.contextWindow).toBe(40960);
    expect(withLen[0]?.contextWindowSource).toBe("observed");

    const withoutLen = await vllmAdapter.listModels(server, { mode: "none" },
      createFakeProbe({ "/v1/models": ok({ data: [{ id: "m2" }] }) }),
    );
    expect(withoutLen[0]).not.toHaveProperty("contextWindow");
    expect(vllmAdapter.toPiModel(server, withoutLen[0]!).contextWindow).toBe(8192);
  });
});
