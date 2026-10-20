/**
 * OpenAI adapter conformance test. Runs the frozen conformance suite against the
 * OpenAI fixture. All assertions live in the harness; this file only wires them.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { openaiFixture } from "./openai.fixture.ts";

runConformance([openaiFixture]);

import { describe, expect, it } from "vitest";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { openaiAdapter } from "../../src/adapters/openai.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

describe("openai window provenance", () => {
  const server: DiscoveredServer = {
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: "apiKey",
    label: "OpenAI",
    confidence: 1,
  };

  it("labels provider-table windows as declared and reports no window for unknown ids", async () => {
    const ok = (json: unknown): ProbeResult => ({
      status: 200,
      ok: true,
      headers: {},
      json,
    });
    const models = await openaiAdapter.listModels(
      server,
      { mode: "apiKey", apiKey: "k" },
      createFakeProbe({ "/v1/models": ok({ data: [{ id: "gpt-4o" }, { id: "mystery-9000" }] }) }),
    );
    expect(models.find((m) => m.id === "gpt-4o")?.contextWindowSource).toBe("declared");
    // Unknown id: no fabricated window — the boundary fallback applies.
    const mystery = models.find((m) => m.id === "mystery-9000")!;
    expect(mystery).not.toHaveProperty("contextWindow");
    expect(openaiAdapter.toPiModel(server, mystery).contextWindow).toBe(8192);
  });
});
