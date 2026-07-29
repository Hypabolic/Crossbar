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
    const models = await omlxAdapter.listModels(omlxServer, { mode: "apiKey", apiKey: "x" }, makeOmlxProbe(REPORTED_MAX_MODEL_LEN));
    expect(models.length).toBeGreaterThan(0);
    expect(models.at(0)!.contextWindow).toBe(REPORTED_MAX_MODEL_LEN);
  });

  it("generic adapter: contextWindow defaults to 8192 when no max_model_len", async () => {
    const models = await genericAdapter.listModels(genericServer, { mode: "none" }, makeGenericProbe());
    expect(models.length).toBeGreaterThan(0);
    expect(models.at(0)!.contextWindow).toBe(8192);
  });
});
