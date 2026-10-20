/**
 * Anthropic adapter conformance test. Runs the frozen conformance suite against
 * the Anthropic fixture. All assertions live in the harness; this file only wires
 * them.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { anthropicFixture } from "./anthropic.fixture.ts";

runConformance([anthropicFixture]);

import { describe, expect, it } from "vitest";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

describe("anthropic window provenance", () => {
  const server: DiscoveredServer = {
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: "apiKey",
    label: "Anthropic",
    confidence: 1,
  };

  it("labels declared windows (API row or static table) and reports no window for unknown ids", async () => {
    const ok = (json: unknown): ProbeResult => ({
      status: 200,
      ok: true,
      headers: {},
      json,
    });
    const models = await anthropicAdapter.listModels(
      server,
      { mode: "apiKey", apiKey: "k" },
      createFakeProbe({
        "/v1/models": ok({
          data: [
            // API-reported max_input_tokens wins and is a provider declaration.
            { id: "claude-3-5-haiku-20241022", max_input_tokens: 190_000 },
            // Static-table match (no API field) — also a provider declaration.
            { id: "claude-opus-4-20250101" },
            // Unknown id: no fabricated window.
            { id: "mystery-9000" },
          ],
        }),
      }),
    );
    expect(models.find((m) => m.id === "claude-3-5-haiku-20241022")?.contextWindow).toBe(190_000);
    expect(models.find((m) => m.id === "claude-3-5-haiku-20241022")?.contextWindowSource).toBe("declared");
    expect(models.find((m) => m.id === "claude-opus-4-20250101")?.contextWindowSource).toBe("declared");
    const mystery = models.find((m) => m.id === "mystery-9000")!;
    expect(mystery).not.toHaveProperty("contextWindow");
    expect(anthropicAdapter.toPiModel(server, mystery).contextWindow).toBe(8192);
  });
});
