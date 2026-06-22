/**
 * Unit tests for the health-poll orchestration (src/poll.ts).
 *
 * `modelsChanged` and `catalogueChanged` are pure. `pollServer` is exercised
 * against fake adapters (via a module mock of adapters/index.ts), a spied
 * `reRegisterServer`, and a fake registry — no network, no real Pi.
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
const { modelsChanged, catalogueChanged, pollServer } = await import("../src/poll.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function model(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id, name: id, input: ["text"], ...overrides };
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
  const setLastKnownModelsSpy = vi.fn(async (_id: string, _models: ModelDescriptor[]) => {});
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
    setLastKnownModels: setLastKnownModelsSpy,
  } as unknown as ServerRegistry;
  return { registry, healthSet, cachePatches, setLastKnownModelsSpy };
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

// ── catalogueChanged ────────────────────────────────────────────────────────

describe("catalogueChanged", () => {
  it("is false for identical model lists", () => {
    const m = model("a", { name: "A", contextWindow: 4096, maxTokens: 2048, reasoning: true, tools: true });
    expect(catalogueChanged([m], [{ ...m }])).toBe(false);
  });

  it("is true when the id set changes (model added)", () => {
    expect(catalogueChanged([model("a")], [model("a"), model("b")])).toBe(true);
  });

  it("is true when the id set changes (model removed)", () => {
    expect(catalogueChanged([model("a"), model("b")], [model("a")])).toBe(true);
  });

  it("is false when model order changes but content is identical", () => {
    const a = model("a");
    const b = model("b");
    expect(catalogueChanged([a, b], [b, a])).toBe(false);
  });

  it("is true when contextWindow changes for an existing model", () => {
    const prev = [model("a", { contextWindow: 4096 })];
    const next = [model("a", { contextWindow: 8192 })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is true when maxTokens changes for an existing model", () => {
    const prev = [model("a", { maxTokens: 1024 })];
    const next = [model("a", { maxTokens: 2048 })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is true when name changes for an existing model", () => {
    const prev = [model("a", { name: "Old Name" })];
    const next = [model("a", { name: "New Name" })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is true when input modalities change", () => {
    const prev = [model("a", { input: ["text"] })];
    const next = [model("a", { input: ["text", "image"] })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is false when input modalities are reordered but identical as a set", () => {
    const prev = [model("a", { input: ["text", "image"] })];
    const next = [model("a", { input: ["image", "text"] })];
    expect(catalogueChanged(prev, next)).toBe(false);
  });

  it("is true when reasoning flag changes", () => {
    const prev = [model("a", { reasoning: false })];
    const next = [model("a", { reasoning: true })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is true when tools flag changes", () => {
    const prev = [model("a", { tools: false })];
    const next = [model("a", { tools: true })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is true when embeddings flag changes", () => {
    const prev = [model("a", { embeddings: false })];
    const next = [model("a", { embeddings: true })];
    expect(catalogueChanged(prev, next)).toBe(true);
  });

  it("is true when prev is undefined and next is non-empty", () => {
    expect(catalogueChanged(undefined, [model("a")])).toBe(true);
  });

  it("is false when prev is undefined and next is empty", () => {
    expect(catalogueChanged(undefined, [])).toBe(false);
  });
});

// ── pollServer ────────────────────────────────────────────────────────────────

describe("pollServer", () => {
  it("records the health state and refreshes models without re-registering when unchanged", async () => {
    __adapterMap.set("ollama", fakeAdapter("ollama", { health: "healthy", models: [model("a")] }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, healthSet, setLastKnownModelsSpy } = fakeRegistry(rec);

    const state = await pollServer(pi, registry, rec);

    expect(state).toBe("healthy");
    expect(healthSet).toEqual(["healthy"]);
    expect(reRegisterSpy).not.toHaveBeenCalled();
    expect(setLastKnownModelsSpy).not.toHaveBeenCalled();
  });

  it("persists the catalogue THEN re-registers when the model set changed", async () => {
    __adapterMap.set("ollama", fakeAdapter("ollama", { models: [model("a"), model("b")] }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, setLastKnownModelsSpy } = fakeRegistry(rec);

    // Track call order
    const callOrder: string[] = [];
    setLastKnownModelsSpy.mockImplementation(async () => { callOrder.push("setLastKnownModels"); });
    reRegisterSpy.mockImplementation(async () => { callOrder.push("reRegister"); });

    await pollServer(pi, registry, rec);

    expect(setLastKnownModelsSpy).toHaveBeenCalledTimes(1);
    expect(reRegisterSpy).toHaveBeenCalledTimes(1);
    // Persist must happen before re-register
    expect(callOrder).toEqual(["setLastKnownModels", "reRegister"]);
  });

  it("does NOT call setLastKnownModels when catalogue is unchanged", async () => {
    __adapterMap.set("ollama", fakeAdapter("ollama", { models: [model("a")] }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, setLastKnownModelsSpy } = fakeRegistry(rec);

    await pollServer(pi, registry, rec);

    expect(setLastKnownModelsSpy).not.toHaveBeenCalled();
    expect(reRegisterSpy).not.toHaveBeenCalled();
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

  it("updates lastSeenAt ephemerally regardless of catalogue change", async () => {
    __adapterMap.set("ollama", fakeAdapter("ollama", { models: [model("a")] }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, cachePatches } = fakeRegistry(rec);

    await pollServer(pi, registry, rec);

    // At least one cache patch with a lastSeenAt timestamp
    expect(
      cachePatches.some((p) => typeof (p as { lastSeenAt?: unknown }).lastSeenAt === "number"),
    ).toBe(true);
  });

  it("calls setLastKnownModels with the new models when catalogue changed", async () => {
    const newModels = [model("a"), model("b")];
    __adapterMap.set("ollama", fakeAdapter("ollama", { models: newModels }));
    const rec = record({ lastKnownModels: [model("a")] });
    const { registry, setLastKnownModelsSpy } = fakeRegistry(rec);

    await pollServer(pi, registry, rec);

    expect(setLastKnownModelsSpy).toHaveBeenCalledWith(rec.id, newModels);
  });
});
