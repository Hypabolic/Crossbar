/**
 * LM Studio v0 fallback — verifies the adapter still works against pre-0.4.0 LM Studio, which has no
 * native /api/v1/* API: a 404 on /api/v1/models must transparently fall back to /api/v0/models.
 * (The main conformance suite drives the modern /api/v1/models path; this guards the fallback.)
 */

import { describe, it, expect } from "vitest";

import { lmstudioAdapter } from "../../src/adapters/lmstudio.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import type { DiscoveredServer } from "../../src/core/types.ts";

const NOT_FOUND: ProbeResult = { status: 404, ok: false, headers: {}, text: "Not Found" };

const V0_MODELS: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      { id: "old-chat", type: "llm", state: "loaded", compatibility_type: "gguf", max_context_length: 16384 },
      { id: "old-embed", type: "embeddings", state: "not-loaded", compatibility_type: "gguf", max_context_length: 512 },
    ],
  },
};

// v1 is absent (404) on pre-0.4.0; only v0 responds.
const ROUTES = { "/api/v1/models": NOT_FOUND, "/api/v0/models": V0_MODELS };

const server: DiscoveredServer = {
  kind: "lmstudio",
  baseUrl: "http://127.0.0.1:1234",
  auth: "none",
  label: "LM Studio (old)",
  confidence: 0.95,
};

describe("[lmstudio] v0 fallback for pre-0.4.0 servers", () => {
  it("fingerprints via /api/v0/models when /api/v1/models 404s", async () => {
    const result = await lmstudioAdapter.fingerprint("http://127.0.0.1:1234", createFakeProbe(ROUTES));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("lmstudio");
  });

  it("lists models via the v0 fallback", async () => {
    const models = await lmstudioAdapter.listModels(server, { mode: "none" }, createFakeProbe(ROUTES));
    expect(models.map((m) => m.id)).toContain("old-chat");
    expect(models.filter((m) => !m.embeddings).map((m) => m.id)).not.toContain("old-embed");
  });

  it("introspects loaded models via the v0 fallback", async () => {
    const state = await lmstudioAdapter.introspectLoaded!(server, { mode: "none" }, createFakeProbe(ROUTES));
    expect(state.source).toBe("introspection");
    expect(state.loadedModelIds).toContain("old-chat");
  });

  it("still surfaces a real 401 (does not fall back on auth failure)", async () => {
    const authRoutes = { "/api/v1/models": { status: 401, ok: false, headers: {} } as ProbeResult };
    await expect(
      lmstudioAdapter.listModels(server, { mode: "none" }, createFakeProbe(authRoutes)),
    ).rejects.toThrow();
  });
});
