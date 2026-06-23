/**
 * The lmstudio adapter memoizes which origins serve the unrecognised v1 shape so it can
 * skip the v1 probe on later calls. Two regressions guarded here:
 *   1. Steady state is ONE request (v0) per call once learned — not v1+v0 every time.
 *   2. A transient v1 error does NOT poison the memo: it only sticks once v0 validates.
 */

import { describe, it, expect } from "vitest";

import { lmstudioAdapter } from "../../src/adapters/lmstudio.ts";
import type { DiscoveredServer, Probe, ProbeResult } from "../../src/core/types.ts";

// Distinct origins per test so the singleton adapter's per-origin memo never bleeds
// between cases (vitest isolates modules per file, so the Set starts empty here).
function serverAt(baseUrl: string): DiscoveredServer {
  return { kind: "lmstudio", baseUrl, auth: "none", label: "LM Studio", confidence: 1 };
}

const V0_VALID: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { data: [{ id: "m", state: "loaded", compatibility_type: "gguf", max_context_length: 4096 }] },
};
const V1_NEW_SHAPE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { models: [{ key: "m", max_context_length: 4096 }] },
};
const V1_TRANSIENT_500: ProbeResult = { status: 500, ok: false, headers: {} };
const V0_ALSO_500: ProbeResult = { status: 500, ok: false, headers: {} };

/** A probe that records the paths it was asked for and replays a per-path response. */
function recordingProbe(routes: Record<string, ProbeResult>): { probe: Probe; paths: string[] } {
  const paths: string[] = [];
  const probe: Probe = async (path: string) => {
    paths.push(path);
    const r = routes[path];
    if (!r) throw new Error(`unexpected path ${path}`);
    return r;
  };
  return { probe, paths };
}

describe("lmstudio v0 memoization", () => {
  it("learns v0 once v0 validates, then issues a single v0 request per call", async () => {
    const server = serverAt("http://127.0.0.1:1234");
    const routes = { "/api/v1/models": V1_NEW_SHAPE, "/api/v0/models": V0_VALID };

    const first = recordingProbe(routes);
    await lmstudioAdapter.listModels!(server, { mode: "none" }, first.probe);
    expect(first.paths).toEqual(["/api/v1/models", "/api/v0/models"]);

    const second = recordingProbe(routes);
    await lmstudioAdapter.listModels!(server, { mode: "none" }, second.probe);
    expect(second.paths).toEqual(["/api/v0/models"]); // v1 skipped — memo hit
  });

  it("does NOT poison the memo on a transient v1 error when v0 doesn't validate", async () => {
    const server = serverAt("http://127.0.0.1:5678");
    const routes = { "/api/v1/models": V1_TRANSIENT_500, "/api/v0/models": V0_ALSO_500 };

    const first = recordingProbe(routes);
    await lmstudioAdapter.health!(server, { mode: "none" }, first.probe);
    expect(first.paths).toEqual(["/api/v1/models", "/api/v0/models"]);

    // Next call must still try v1 first — the transient failure was not memoized.
    const second = recordingProbe(routes);
    await lmstudioAdapter.health!(server, { mode: "none" }, second.probe);
    expect(second.paths[0]).toBe("/api/v1/models");
  });
});
