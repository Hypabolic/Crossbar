/**
 * Regression: llama-swap's real /running response is `{ running: [ { model, ... } ] }`.
 * The fingerprint guard accepts it, so introspectLoaded must extract ids from it too —
 * otherwise detection works but the loaded-model list is silently empty.
 */

import { describe, it, expect } from "vitest";

import { llamaswapAdapter } from "../../src/adapters/llamaswap.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import type { RouteMap } from "../conformance/fake-probe.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

const server: DiscoveredServer = {
  kind: "llamaswap",
  baseUrl: "http://127.0.0.1:8080",
  auth: "none",
  label: "llama-swap",
  confidence: 0.9,
};

function runningRoute(json: unknown): RouteMap {
  const res: ProbeResult = { status: 200, ok: true, headers: { "content-type": "application/json" }, json };
  return { "/running": res };
}

describe("llamaswap introspectLoaded — /running shapes", () => {
  it("extracts ids from the real { running: [ { model } ] } shape", async () => {
    const probe = createFakeProbe(runningRoute({ running: [{ model: "qwen-7b", state: "ready" }, { model: "llama-8b" }] }));
    const state = await llamaswapAdapter.introspectLoaded!(server, { mode: "none" }, probe);
    expect(state.loadedModelIds).toEqual(["qwen-7b", "llama-8b"]);
  });

  it("also handles { running: [ { id } ] }", async () => {
    const probe = createFakeProbe(runningRoute({ running: [{ id: "model-a" }] }));
    const state = await llamaswapAdapter.introspectLoaded!(server, { mode: "none" }, probe);
    expect(state.loadedModelIds).toEqual(["model-a"]);
  });

  it("fingerprints the same { running: [...] } body as llama-swap", async () => {
    const probe = createFakeProbe(runningRoute({ running: [{ model: "qwen-7b" }] }));
    const r = await llamaswapAdapter.fingerprint(server.baseUrl, probe);
    expect(r?.kind).toBe("llamaswap");
  });
});
