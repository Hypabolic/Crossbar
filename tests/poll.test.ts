/**
 * Unit tests for the health-poll orchestration (src/poll.ts).
 *
 * `modelsChanged` is pure. `pollServer` is exercised against fake adapters (via a
 * module mock of adapters/index.ts), a spied `reRegisterServer`, and a fake
 * registry — no network, no real Pi.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { Capability } from "../src/core/capability.ts";
import type { BackendAdapter } from "../src/core/backend-adapter.ts";
import type { BackendKind } from "../src/core/capability.ts";
import type {
  HealthState,
  ModelDescriptor,
  ServerCredential,
  ServerRecord,
} from "../src/core/types.ts";
import type { ServerRegistry } from "../src/registry/registry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Module mocks ──────────────────────────────────────────────────────────────

const reRegisterSpy = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../src/shim/provider-shim.ts", () => ({
  reRegisterServer: (...args: unknown[]) => reRegisterSpy(...args),
}));

vi.mock("../src/adapters/index.ts", () => ({
  adapterFor: (kind: BackendKind): BackendAdapter => {
    const adapter = __adapterMap.get(kind);
    if (!adapter) throw new Error(`no fake adapter for ${kind}`);
    return adapter;
  },
}));

vi.mock("../src/discovery/probe.ts", () => ({
  createProbe: () => async () => ({ status: 200, ok: true, headers: {} }),
  DEFAULT_DISCOVERY_TIMEOUT_MS: 600,
}));

const __adapterMap = new Map<BackendKind, BackendAdapter>();

// Imported after the mocks above are registered.
const { modelsChanged, pollServer } = await import("../src/poll.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function model(id: string): ModelDescriptor {
  return { id, name: id, input: ["text"] };
}

interface FakeAdapterOpts {
  health?: HealthState | Error;
  models?: ModelDescriptor[] | Error;
  hasHealth?: boolean;
}

function fakeAdapter(kind: BackendKind, opts: FakeAdapterOpts): BackendAdapter {
  const caps = new Set<Capability>([Capability.ListModels]);
  if (opts.hasHealth !== false) caps.add(Capability.Health);

  const adapter: Partial<BackendAdapter> = {
    kind,
    capabilities: caps,
    async listModels(): Promise<ModelDescriptor[]> {
      if (opts.models instanceof Error) throw opts.models;
      return opts.models ?? [];
    },
  };
  if (opts.hasHealth !== false) {
    adapter.health = async () => {
      if (opts.health instanceof Error) throw opts.health;
      return { state: (opts.health as HealthState) ?? "healthy" };
    };
  }
  return adapter as BackendAdapter;
}

function record(over: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: "crossbar-ollama-localhost-11434",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    label: "Ollama",
    auth: "none",
    enabled: true,
    addedAt: 0,
    ...over,
  };
}

function fakeRegistry(rec: ServerRecord) {
  const healthSet: HealthState[] = [];
  const cachePatches: unknown[] = [];
  const registry = {
    list: () => [rec],
    async resolveCredential(): Promise<ServerCredential> {
      return { mode: "none" };
    },
    updateHealthCache: (_id: string, patch: unknown) => {
      cachePatches.push(patch);
    },
    setHealth: (_id: string, state: HealthState) => {
      healthSet.push(state);
    },
    getHealth: () => undefined,
  } as unknown as ServerRegistry;
  return { registry, healthSet, cachePatches };
}

const pi = {} as ExtensionAPI;

beforeEach(() => {
  reRegisterSpy.mockClear();
  __adapterMap.clear();
});

// ── modelsChanged ───────────────────────────────────────────────────────────

describe("modelsChanged", () => {
  it("is false for the same id set in a different order", () => {
    expect(modelsChanged([model("a"), model("b")], [model("b"), model("a")])).toBe(false);
  });
  it("is true when a model is added", () => {
    expect(modelsChanged([model("a")], [model("a"), model("b")])).toBe(true);
  });
  it("is true when a model is removed", () => {
    expect(modelsChanged([model("a"), model("b")], [model("a")])).toBe(true);
  });
  it("is true when prev is undefined and next is non-empty", () => {
    expect(modelsChanged(undefined, [model("a")])).toBe(true);
  });
  it("is false when prev is undefined and next is empty", () => {
    expect(modelsChanged(undefined, [])).toBe(false);
  });
});

// ── pollServer ────────────────────────────────────────────────────────────────

describe("pollServer", () => {
  it("records the health state and refreshes models without re-registering when unchanged", async () => {
    __adapterMap.set("ollama", fakeAdapter("ollama", { health: "healthy", models: [model("a")] }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, healthSet, cachePatches } = fakeRegistry(rec);

    const state = await pollServer(pi, registry, rec);

    expect(state).toBe("healthy");
    expect(healthSet).toEqual(["healthy"]);
    expect(reRegisterSpy).not.toHaveBeenCalled();
    expect(cachePatches.some((p) => Array.isArray((p as { models?: unknown }).models))).toBe(true);
  });

  it("re-registers when the model set changed", async () => {
    __adapterMap.set("ollama", fakeAdapter("ollama", { models: [model("a"), model("b")] }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry } = fakeRegistry(rec);

    await pollServer(pi, registry, rec);

    expect(reRegisterSpy).toHaveBeenCalledTimes(1);
  });

  it("reports unreachable when the health probe throws", async () => {
    __adapterMap.set(
      "ollama",
      fakeAdapter("ollama", { health: new Error("refused"), models: [model("a")] }),
    );
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, healthSet } = fakeRegistry(rec);

    expect(await pollServer(pi, registry, rec)).toBe("unreachable");
    expect(healthSet).toEqual(["unreachable"]);
  });

  it("infers healthy from listModels for backends without a health endpoint", async () => {
    __adapterMap.set(
      "openai-generic",
      fakeAdapter("openai-generic", { hasHealth: false, models: [model("a")] }),
    );
    const rec = record({ kind: "openai-generic", lastKnownModels: [model("a")] });
    const { registry } = fakeRegistry(rec);

    expect(await pollServer(pi, registry, rec)).toBe("healthy");
  });

  it("infers unreachable when listModels fails and there is no health endpoint", async () => {
    __adapterMap.set(
      "openai-generic",
      fakeAdapter("openai-generic", { hasHealth: false, models: new Error("down") }),
    );
    const rec = record({ kind: "openai-generic", lastKnownModels: [model("a")] });
    const { registry } = fakeRegistry(rec);

    expect(await pollServer(pi, registry, rec)).toBe("unreachable");
    expect(reRegisterSpy).not.toHaveBeenCalled();
  });
});
