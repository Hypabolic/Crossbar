/**
 * Crossbar conformance runner — the parameterised contract suite, extracted into a plain (non-test)
 * module so any adapter's `*.test.ts` can `import { runConformance }` and call it WITHOUT triggering
 * another file's suite as an import side effect.
 *
 * Usage (Wave B):
 *   import { runConformance } from "../conformance/run-conformance.ts";
 *   import { ollamaFixture } from "./ollama.fixture.ts";
 *   runConformance([ollamaFixture]);
 *
 * Validates every invariant in ARCHITECTURE.md §2 and §8.
 * HARD RULES: no network (fake Probe only), no src/core/ changes, vitest only.
 */

import { describe, it, expect } from "vitest";

import { Capability } from "../../src/core/capability.ts";
import {
  canIntrospect,
  canLoadUnload,
  canSwitch,
  supports,
} from "../../src/core/backend-adapter.ts";
import type { DiscoveredServer } from "../../src/core/types.ts";

import { createFakeProbe } from "./fake-probe.ts";
import type { RouteMap } from "./fake-probe.ts";
import type { AdapterFixture } from "./fixtures.ts";

/** Run the full conformance suite against every fixture. Call at module level in a `*.test.ts`. */
export function runConformance(fixtures: AdapterFixture[]): void {
  for (const fixture of fixtures) {
    describeAdapter(fixture);
  }
}

function describeAdapter(fixture: AdapterFixture): void {
  const { name, adapter, cred, routes, expect: exp } = fixture;

  describe(`[conformance] ${name}`, () => {
    // 1. CAPABILITY HONESTY
    describe("capability honesty", () => {
      it("introspectLoaded defined ↔ IntrospectLoaded capability", () => {
        expect(canIntrospect(adapter)).toBe(supports(adapter, Capability.IntrospectLoaded));
      });
      it("switchModel defined ↔ SwitchModel capability", () => {
        expect(canSwitch(adapter)).toBe(supports(adapter, Capability.SwitchModel));
      });
      it("loadUnload defined ↔ LoadUnload capability", () => {
        expect(canLoadUnload(adapter)).toBe(supports(adapter, Capability.LoadUnload));
      });
      it("health defined ↔ Health capability", () => {
        expect(typeof adapter.health === "function").toBe(supports(adapter, Capability.Health));
      });
      it("ListModels is always declared", () => {
        expect(supports(adapter, Capability.ListModels)).toBe(true);
      });
    });

    // 2. FINGERPRINT — skipped for cloud adapters (configured, never probed).
    describe.skipIf(fixture.cloud === true)("fingerprint", () => {
      it("positive: returns a DiscoveredServer with expected kind and confidence", async () => {
        const probe = createFakeProbe(routes as RouteMap);
        const result = await adapter.fingerprint("http://127.0.0.1:19999", probe);
        expect(result).not.toBeNull();
        const server = result!;
        expect(server.kind).toBe(exp.fingerprint.kind);
        expect(server.confidence).toBeGreaterThanOrEqual(exp.fingerprint.confidenceMin);
        expect(server.confidence).toBeLessThanOrEqual(exp.fingerprint.confidenceMax);
        expect(typeof server.baseUrl).toBe("string");
        expect(server.baseUrl.length).toBeGreaterThan(0);
        expect(typeof server.label).toBe("string");
        expect(server.label.length).toBeGreaterThan(0);
      });

      it("negative: returns null against another backend's responses", async () => {
        const negRoutes: RouteMap = fixture.negativeRoutes ? (fixture.negativeRoutes as RouteMap) : {};
        const probe = createFakeProbe(negRoutes);
        expect(await adapter.fingerprint("http://127.0.0.1:19999", probe)).toBeNull();
      });

      it("returns null when all probes return status:0 (connection refused)", async () => {
        const probe = createFakeProbe({});
        expect(await adapter.fingerprint("http://127.0.0.1:19999", probe)).toBeNull();
      });
    });

    // 3. listModels
    describe("listModels", () => {
      it("returns all expected model ids", async () => {
        const server = resolveServer(fixture);
        const models = await adapter.listModels(server, cred, createFakeProbe(routes as RouteMap));
        for (const id of exp.models.includedIds) {
          expect(models.map((m) => m.id)).toContain(id);
        }
      });

      it("filters embeddings models out of chat list", async () => {
        const server = resolveServer(fixture);
        const models = await adapter.listModels(server, cred, createFakeProbe(routes as RouteMap));
        const chatModels = models.filter((m) => !m.embeddings);
        for (const id of exp.models.excludedIds) {
          expect(chatModels.map((m) => m.id)).not.toContain(id);
        }
      });

      it("returns at least the expected minimum count (non-embedding)", async () => {
        const server = resolveServer(fixture);
        const models = await adapter.listModels(server, cred, createFakeProbe(routes as RouteMap));
        expect(models.filter((m) => !m.embeddings).length).toBeGreaterThanOrEqual(exp.models.minCount);
      });

      it("each model has a non-empty input modality array", async () => {
        const server = resolveServer(fixture);
        const models = await adapter.listModels(server, cred, createFakeProbe(routes as RouteMap));
        for (const m of models) {
          expect(Array.isArray(m.input)).toBe(true);
          expect(m.input.length).toBeGreaterThan(0);
        }
      });

      it("rejects (throws) on 401 auth failure", async () => {
        const authRoutes: RouteMap = fixture.authFailureRoutes ? (fixture.authFailureRoutes as RouteMap) : {};
        const server = resolveServer(fixture);
        await expect(adapter.listModels(server, cred, createFakeProbe(authRoutes))).rejects.toThrow();
      });
    });

    // 4. toPiModel
    describe("toPiModel", () => {
      it("returns a structurally valid Pi model entry for every chat model", async () => {
        const server = resolveServer(fixture);
        const models = await adapter.listModels(server, cred, createFakeProbe(routes as RouteMap));
        const chatModels = models.filter((m) => !m.embeddings);
        expect(chatModels.length).toBeGreaterThan(0);
        for (const model of chatModels) {
          const entry = adapter.toPiModel(server, model);
          expect(typeof entry.id).toBe("string");
          expect(entry.id.length).toBeGreaterThan(0);
          expect(typeof entry.name).toBe("string");
          expect(entry.name.length).toBeGreaterThan(0);
          expect(Array.isArray(entry.input)).toBe(true);
          expect(entry.input.length).toBeGreaterThan(0);
          for (const mod of entry.input) expect(["text", "image"]).toContain(mod);
          expect(typeof entry.cost.input).toBe("number");
          expect(typeof entry.cost.output).toBe("number");
          expect(typeof entry.cost.cacheRead).toBe("number");
          expect(typeof entry.cost.cacheWrite).toBe("number");
          expect(typeof entry.contextWindow).toBe("number");
          expect(entry.contextWindow).toBeGreaterThan(0);
          expect(typeof entry.maxTokens).toBe("number");
          expect(entry.maxTokens).toBeGreaterThan(0);
          expect(typeof entry.reasoning).toBe("boolean");
        }
      });
    });

    // 5. inferenceBaseUrl
    describe("inferenceBaseUrl", () => {
      it("returns a non-empty http(s) URL starting with the expected prefix", () => {
        const url = adapter.inferenceBaseUrl(resolveServer(fixture));
        expect(typeof url).toBe("string");
        expect(url).toMatch(/^https?:\/\//);
        expect(url.startsWith(exp.inferenceBaseUrlPrefix)).toBe(true);
      });
    });

    // 6. health (when capability present)
    if (supports(adapter, Capability.Health)) {
      describe("health", () => {
        it("success path returns 'healthy' or 'loading'", async () => {
          const status = await adapter.health!(resolveServer(fixture), cred, createFakeProbe(routes as RouteMap));
          expect(["healthy", "loading"]).toContain(status.state);
        });
        it("unreachable probe returns a degraded state (not a throw)", async () => {
          const status = await adapter.health!(resolveServer(fixture), cred, createFakeProbe({}));
          expect(["unreachable", "degraded", "unauthorized"]).toContain(status.state);
        });
      });
    }

    // 7. introspectLoaded (when capability present)
    if (supports(adapter, Capability.IntrospectLoaded)) {
      describe("introspectLoaded", () => {
        it("success path: source 'introspection' and contains expected ids", async () => {
          const state = await adapter.introspectLoaded!(resolveServer(fixture), cred, createFakeProbe(routes as RouteMap));
          expect(state.source).toBe("introspection");
          expect(Array.isArray(state.loadedModelIds)).toBe(true);
          if (exp.loadedState) {
            const overlap = state.loadedModelIds.filter((id) => exp.loadedState!.anyOf.includes(id));
            expect(overlap.length).toBeGreaterThan(0);
          }
        });
        it("rejects on 401 auth failure", async () => {
          const authRoutes: RouteMap = fixture.authFailureRoutes ? (fixture.authFailureRoutes as RouteMap) : {};
          await expect(
            adapter.introspectLoaded!(resolveServer(fixture), cred, createFakeProbe(authRoutes)),
          ).rejects.toThrow();
        });
        it("handles streaming-cutoff / status:0 gracefully (throws, not hangs)", async () => {
          await expect(
            adapter.introspectLoaded!(resolveServer(fixture), cred, createFakeProbe({})),
          ).rejects.toThrow();
        });
      });
    }

    // 8. switchModel (when capability present)
    if (supports(adapter, Capability.SwitchModel)) {
      describe("switchModel", () => {
        const targetId = fixture.switchModelId ?? fixture.expect.models.includedIds[0] ?? "model-a";

        it("success path completes without throwing", async () => {
          const switchRoutes: RouteMap = fixture.switchSuccessRoutes
            ? { ...(routes as RouteMap), ...(fixture.switchSuccessRoutes as RouteMap) }
            : (routes as RouteMap);
          await expect(
            adapter.switchModel!(resolveServer(fixture), cred, targetId, createFakeProbe(switchRoutes)),
          ).resolves.toBeUndefined();
        });
        it("server-down-mid-switch: rejects", async () => {
          const downRoutes: RouteMap = fixture.serverDownRoutes ? (fixture.serverDownRoutes as RouteMap) : {};
          await expect(
            adapter.switchModel!(resolveServer(fixture), cred, targetId, createFakeProbe(downRoutes)),
          ).rejects.toThrow();
        });
        it("auth-failure during switch: rejects", async () => {
          await expect(
            adapter.switchModel!(resolveServer(fixture), cred, targetId, createFakeProbe({})),
          ).rejects.toThrow();
        });
        it("model-not-loaded after switch: rejects", async () => {
          const missingId = fixture.missingModelId ?? "no-such-model";
          await expect(
            adapter.switchModel!(resolveServer(fixture), cred, missingId, createFakeProbe({})),
          ).rejects.toThrow();
        });
      });
    }

    // 9. loadUnload (when capability present)
    if (supports(adapter, Capability.LoadUnload)) {
      describe("loadUnload", () => {
        const targetId = fixture.loadModelId ?? fixture.expect.models.includedIds[0] ?? "model-a";

        it("load: success path completes without throwing", async () => {
          await expect(
            adapter.loadUnload!(resolveServer(fixture), cred, targetId, "load", createFakeProbe(routes as RouteMap)),
          ).resolves.toBeUndefined();
        });
        it("unload: success path completes without throwing", async () => {
          await expect(
            adapter.loadUnload!(resolveServer(fixture), cred, targetId, "unload", createFakeProbe(routes as RouteMap)),
          ).resolves.toBeUndefined();
        });
        it("load: server-down rejects", async () => {
          await expect(
            adapter.loadUnload!(resolveServer(fixture), cred, targetId, "load", createFakeProbe({})),
          ).rejects.toThrow();
        });
        it("load: 401 rejects", async () => {
          const authRoutes: RouteMap = fixture.authFailureRoutes ? (fixture.authFailureRoutes as RouteMap) : {};
          await expect(
            adapter.loadUnload!(resolveServer(fixture), cred, targetId, "load", createFakeProbe(authRoutes)),
          ).rejects.toThrow();
        });
      });
    }
  });
}

/** Use the fixture's pre-built server, or synthesise a minimal one from the expected fingerprint. */
function resolveServer(fixture: AdapterFixture): DiscoveredServer {
  if (fixture.server) return fixture.server;
  return {
    kind: fixture.expect.fingerprint.kind,
    baseUrl: "http://127.0.0.1:19999",
    auth: fixture.cred.mode,
    label: fixture.name,
    confidence: fixture.expect.fingerprint.confidenceMin,
  };
}
