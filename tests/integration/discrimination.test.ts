/**
 * Cross-adapter discrimination — the integration concern no single Wave B agent could test:
 * when ALL real adapters compete, does each backend's responses resolve to the correct kind, and
 * does the generic fallback never shadow a specific adapter?
 *
 * Drives the REAL discovery engine (`discoverLocalhost` + `probeOrigin`) via an injected
 * `probeFactory` that serves each origin from the matching backend's recorded fixture routes.
 */

import { describe, it, expect } from "vitest";

import { discoverLocalhost, probeOrigin } from "../../src/discovery/engine.ts";
import { DISCOVERY_ADAPTERS } from "../../src/adapters/index.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import type { RouteMap } from "../conformance/fake-probe.ts";

import { ollamaFixture } from "../adapters/ollama.fixture.ts";
import { lmstudioFixture } from "../adapters/lmstudio.fixture.ts";
import { vllmFixture } from "../adapters/vllm.fixture.ts";
import { llamacppFixture } from "../adapters/llamacpp.fixture.ts";
import { llamaswapFixture } from "../adapters/llamaswap.fixture.ts";
import { genericFixture } from "../adapters/generic.fixture.ts";

// One distinct test port per local backend (llamacpp & llamaswap share :8080 in reality; we split
// them here only so a single sweep can exercise both without an origin collision).
const PORT_FIXTURES: Record<number, { routes: RouteMap; kind: string; name: string }> = {
  11434: { routes: ollamaFixture.routes as RouteMap, kind: "ollama", name: "Ollama" },
  1234: { routes: lmstudioFixture.routes as RouteMap, kind: "lmstudio", name: "LM Studio" },
  8000: { routes: vllmFixture.routes as RouteMap, kind: "vllm", name: "vLLM" },
  8080: { routes: llamacppFixture.routes as RouteMap, kind: "llamacpp", name: "llama.cpp" },
  8081: { routes: llamaswapFixture.routes as RouteMap, kind: "llamaswap", name: "llama-swap" },
  5999: { routes: genericFixture.routes as RouteMap, kind: "openai-generic", name: "generic" },
};

function portOf(origin: string): number {
  return Number(new URL(origin).port);
}

/** Serves each origin from its mapped fixture routes; unmapped ports look dead (empty routes). */
function fakeProbeFactory(origin: string) {
  const entry = PORT_FIXTURES[portOf(origin)];
  return createFakeProbe(entry ? entry.routes : {});
}

describe("[integration] cross-adapter discrimination", () => {
  it("a full sweep resolves every origin to the correct backend kind", async () => {
    const ports = Object.keys(PORT_FIXTURES).map(Number);
    const found = await discoverLocalhost([...DISCOVERY_ADAPTERS], {
      ports,
      probeFactory: fakeProbeFactory,
    });

    // One discovery per origin (no false dead-ends, no duplicates).
    expect(found.length).toBe(ports.length);

    const byPort = new Map(found.map((s) => [portOf(s.baseUrl), s.kind]));
    for (const [port, { kind }] of Object.entries(PORT_FIXTURES)) {
      expect(byPort.get(Number(port))).toBe(kind);
    }
  });

  it("an unmapped (dead) port yields no discovery", async () => {
    const found = await discoverLocalhost([...DISCOVERY_ADAPTERS], {
      ports: [6553], // nothing serves this in the fake factory
      probeFactory: fakeProbeFactory,
    });
    expect(found).toEqual([]);
  });

  it("no specific backend false-positives on another's responses (only its kind + maybe generic)", async () => {
    for (const [port, { routes, kind, name }] of Object.entries(PORT_FIXTURES)) {
      if (kind === "openai-generic") continue; // generic legitimately matches any /v1/models
      const probe = createFakeProbe(routes);
      const matches: string[] = [];
      for (const adapter of DISCOVERY_ADAPTERS) {
        const r = await adapter.fingerprint(`http://127.0.0.1:${port}`, probe);
        if (r) matches.push(r.kind);
      }
      // Every matching kind must be either the expected backend or the generic fallback.
      for (const m of matches) {
        expect([kind, "openai-generic"], `${name} matched unexpected kind ${m}`).toContain(m);
      }
      // And the expected backend must be among them.
      expect(matches, `${name} not detected by its own adapter`).toContain(kind);
    }
  });

  it("generic never outranks a specific adapter at the same origin", async () => {
    // Ollama's routes also satisfy generic if it serves /v1/models; the winner must be the specific.
    const probe = createFakeProbe(PORT_FIXTURES[8081]!.routes); // llama-swap (serves /v1/models)
    const winner = await probeOrigin("http://127.0.0.1:8081", [...DISCOVERY_ADAPTERS], 600, () => probe);
    expect(winner).not.toBeNull();
    expect(winner!.kind).toBe("llamaswap");
  });
});
