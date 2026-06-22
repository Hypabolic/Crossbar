/**
 * Unit tests for src/ui/loaded-widget.ts
 *
 * Tests cover the new pure functions:
 *   - formatActiveModel: null/empty, markers ●/○, (last-known), unhealthy ✕ + auth/unreachable/degraded
 *   - computeActiveEntry: no active, unknown provider, introspection success+update, introspect throw→last-known, non-introspect→last-known
 *
 * No Pi runtime, no network I/O, no filesystem.
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatActiveModel,
  computeActiveEntry,
  type ActiveEntry,
} from "../../src/ui/loaded-widget.ts";
import type { ServerRegistry } from "../../src/registry/registry.ts";
import type { ServerRecord, LoadedState, Probe } from "../../src/core/types.ts";
import type { BackendAdapter } from "../../src/core/backend-adapter.ts";
import type { BackendKind } from "../../src/core/capability.ts";
import { Capability } from "../../src/core/capability.ts";
import type { DiscoveredServer } from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Fake theme — identity transform so assertions compare plain text
// ---------------------------------------------------------------------------

const fakeTheme = {
  fg: (_token: string, text: string): string => text,
} as const;

// ---------------------------------------------------------------------------
// formatActiveModel
// ---------------------------------------------------------------------------

describe("formatActiveModel", () => {
  it("returns empty string for null", () => {
    expect(formatActiveModel(null, fakeTheme)).toBe("");
  });

  it("renders ● and label:modelId for healthy + loaded (introspection)", () => {
    const entry: ActiveEntry = {
      label: "Ollama",
      modelId: "llama3.1",
      loaded: true,
      source: "introspection",
      health: "healthy",
    };
    const result = formatActiveModel(entry, fakeTheme);
    expect(result).toContain("●");
    expect(result).toContain("Ollama: llama3.1");
    expect(result).not.toContain("(last-known)");
    expect(result).not.toContain("✕");
  });

  it("renders ○ for healthy + not loaded", () => {
    const entry: ActiveEntry = {
      label: "Ollama",
      modelId: "llama3.1",
      loaded: false,
      source: "introspection",
    };
    const result = formatActiveModel(entry, fakeTheme);
    expect(result).toContain("○");
    expect(result).toContain("Ollama: llama3.1");
  });

  it("renders ✕ and unreachable (not the model) for unreachable health", () => {
    const entry: ActiveEntry = {
      label: "Ollama",
      modelId: "llama3.1",
      loaded: true,
      source: "last-known",
      health: "unreachable",
    };
    const result = formatActiveModel(entry, fakeTheme);
    expect(result).toContain("✕");
    expect(result).toContain("Ollama: unreachable");
    expect(result).not.toContain("llama3.1");
  });

  it("renders auth detail for unauthorized", () => {
    const entry: ActiveEntry = {
      label: "vLLM",
      modelId: "qwen",
      loaded: false,
      source: "last-known",
      health: "unauthorized",
    };
    const result = formatActiveModel(entry, fakeTheme);
    expect(result).toContain("✕");
    expect(result).toContain("vLLM: auth");
  });

  it("renders (last-known) suffix when source is last-known (and not unhealthy)", () => {
    const entry: ActiveEntry = {
      label: "LM Studio",
      modelId: "mistral",
      loaded: true,
      source: "last-known",
    };
    const result = formatActiveModel(entry, fakeTheme);
    expect(result).toContain("●");
    expect(result).toContain("LM Studio: mistral");
    expect(result).toContain("(last-known)");
  });

  it("calls theme.fg for theming (not raw ANSI)", () => {
    const themeWithSpy = {
      fg: vi.fn((_token: string, text: string) => text),
    };
    const entry: ActiveEntry = {
      label: "Ollama",
      modelId: "llama3.1",
      loaded: true,
      source: "introspection",
    };
    formatActiveModel(entry, themeWithSpy);
    expect(themeWithSpy.fg).toHaveBeenCalled();
    for (const call of themeWithSpy.fg.mock.calls) {
      const token = call[0] as string;
      expect(typeof token).toBe("string");
      expect(token).not.toMatch(/\\x1b|\x1b/);
    }
  });

  it("renders degraded health with ✕", () => {
    const entry: ActiveEntry = {
      label: "llama.cpp",
      modelId: "Qwen3",
      loaded: true,
      source: "introspection",
      health: "degraded",
    };
    const result = formatActiveModel(entry, fakeTheme);
    expect(result).toContain("✕");
    expect(result).toContain("llama.cpp: degraded");
  });
});

// ---------------------------------------------------------------------------
// Helpers for computeActiveEntry
// ---------------------------------------------------------------------------

/** Make a minimal ServerRecord for test use. */
function makeRecord(
  overrides: Partial<ServerRecord> & { id: string; kind: BackendKind },
): ServerRecord {
  return {
    baseUrl: "http://127.0.0.1:11434",
    label: overrides.kind,
    auth: "none",
    enabled: true,
    addedAt: 1000,
    ...overrides,
  };
}

/** Minimal fake CredentialStore (synchronous for simplicity). */
class FakeCredentialStore {
  get(_id: string): string | undefined {
    return undefined;
  }
  set(_id: string, _key: string): void {
    /* noop */
  }
  remove(_id: string): void {
    /* noop */
  }
  has(_id: string): boolean {
    return false;
  }
}

/**
 * Build a fake ServerRegistry backed by an in-memory list.
 * Only the methods computeActiveEntry calls are implemented (get, resolve, updateHealthCache, getHealth).
 */
function makeFakeRegistry(records: ServerRecord[]): ServerRegistry {
  const store = new FakeCredentialStore();
  return {
    list(): ServerRecord[] {
      return records;
    },
    get(id: string): ServerRecord | undefined {
      return records.find((r) => r.id === id);
    },
    async resolveCredential(_record: ServerRecord) {
      return { mode: "none" as const };
    },
    // Remaining methods are stubs
    load: () => {
      throw new Error("not implemented");
    },
    add: async () => {
      throw new Error("not implemented");
    },
    update: async () => {
      throw new Error("not implemented");
    },
    remove: async () => {
      throw new Error("not implemented");
    },
    setEnabled: async () => {
      throw new Error("not implemented");
    },
    updateHealthCache: () => {},
    setHealth: () => {},
    getHealth: () => undefined,
  } as unknown as ServerRegistry;
}

/** A fake BackendAdapter with IntrospectLoaded capability. */
function makeIntrospectableAdapter(
  kind: BackendKind,
  introspectResult: LoadedState | Error,
): BackendAdapter {
  return {
    kind,
    displayName: kind,
    defaultPorts: [],
    piApi: "openai-completions",
    capabilities: new Set<Capability>([Capability.ListModels, Capability.IntrospectLoaded]),
    fingerprint: async () => null,
    listModels: async () => [],
    toPiModel: () => {
      throw new Error("not implemented");
    },
    inferenceBaseUrl: (s: DiscoveredServer) => s.baseUrl,
    async introspectLoaded(
      _server: DiscoveredServer,
      _cred: unknown,
      _probe: unknown,
    ): Promise<LoadedState> {
      if (introspectResult instanceof Error) throw introspectResult;
      return introspectResult;
    },
  } as unknown as BackendAdapter;
}

/** A fake BackendAdapter WITHOUT IntrospectLoaded capability. */
function makeNonIntrospectableAdapter(kind: BackendKind): BackendAdapter {
  return {
    kind,
    displayName: kind,
    defaultPorts: [],
    piApi: "openai-completions",
    capabilities: new Set<Capability>([Capability.ListModels]),
    fingerprint: async () => null,
    listModels: async () => [],
    toPiModel: () => {
      throw new Error("not implemented");
    },
    inferenceBaseUrl: (s: DiscoveredServer) => s.baseUrl,
    // introspectLoaded intentionally absent
  } as unknown as BackendAdapter;
}

// ---------------------------------------------------------------------------
// computeActiveEntry — module-level mock of adapter resolution
// ---------------------------------------------------------------------------

// We mock the adapters/index.ts module so computeActiveEntry uses our fake adapters.
vi.mock("../../src/adapters/index.ts", async () => {
  // Keep canIntrospect real (it's from core, not adapters) and only override adapterFor.
  const realAdapters = await vi.importActual<typeof import("../../src/adapters/index.ts")>(
    "../../src/adapters/index.ts",
  );
  return {
    ...realAdapters,
    adapterFor: (kind: BackendKind): BackendAdapter => {
      // Resolved per-test by __testAdapterMap
      const adapter = __testAdapterMap.get(kind);
      if (!adapter) return realAdapters.adapterFor(kind);
      return adapter;
    },
  };
});

// Also mock createProbe so no network calls happen
vi.mock("../../src/discovery/probe.ts", () => ({
  createProbe: (_baseUrl: string, _opts?: unknown): Probe => {
    return async (_path: string) => ({
      status: 200,
      ok: true,
      headers: {},
    });
  },
  DEFAULT_DISCOVERY_TIMEOUT_MS: 600,
}));

/** Global map that each test populates to control adapterFor(). */
const __testAdapterMap = new Map<BackendKind, BackendAdapter>();

// ---------------------------------------------------------------------------
// computeActiveEntry tests
// ---------------------------------------------------------------------------

describe("computeActiveEntry", () => {
  it("returns null when active === undefined", async () => {
    const registry = makeFakeRegistry([]);
    const entry = await computeActiveEntry(registry, undefined);
    expect(entry).toBeNull();
  });

  it("returns null when active provider not in registry", async () => {
    const record = makeRecord({ id: "r1", kind: "ollama" });
    const registry = makeFakeRegistry([record]);
    const entry = await computeActiveEntry(registry, { provider: "unknown", id: "m1" });
    expect(entry).toBeNull();
  });

  it("uses introspection when adapter canIntrospect, records loaded:true when id present, and calls updateHealthCache", async () => {
    const loadedState: LoadedState = {
      loadedModelIds: ["llama3.1", "other"],
      source: "introspection",
    };
    __testAdapterMap.set("ollama", makeIntrospectableAdapter("ollama", loadedState));

    const record = makeRecord({ id: "srv1", kind: "ollama", label: "Ollama", enabled: true });
    const registry = makeFakeRegistry([record]);

    const writes: string[][] = [];
    const regWithSpy = {
      ...registry,
      updateHealthCache: (id: string, patch: { loaded?: string[] }) => {
        if (patch.loaded) writes.push(patch.loaded);
      },
    } as unknown as ServerRegistry;

    const entry = await computeActiveEntry(regWithSpy, { provider: "srv1", id: "llama3.1" });

    expect(entry).not.toBeNull();
    expect(entry?.source).toBe("introspection");
    expect(entry?.loaded).toBe(true);
    expect(entry?.modelId).toBe("llama3.1");
    expect(entry?.label).toBe("Ollama");
    expect(writes).toEqual([["llama3.1", "other"]]);

    __testAdapterMap.delete("ollama");
  });

  it("returns loaded:false via introspection when id not in loaded list", async () => {
    __testAdapterMap.set(
      "ollama",
      makeIntrospectableAdapter("ollama", { loadedModelIds: ["other"], source: "introspection" }),
    );
    const record = makeRecord({ id: "s1", kind: "ollama", enabled: true });
    const registry = makeFakeRegistry([record]);
    const entry = await computeActiveEntry(registry, { provider: "s1", id: "target" });
    expect(entry?.loaded).toBe(false);
    expect(entry?.source).toBe("introspection");
    __testAdapterMap.delete("ollama");
  });

  it("falls back to last-known (loaded derived from record.lastKnownLoaded) when adapter does NOT canIntrospect", async () => {
    __testAdapterMap.set("openai", makeNonIntrospectableAdapter("openai"));

    const record = makeRecord({
      id: "cloud",
      kind: "openai",
      label: "OpenAI",
      enabled: true,
      lastKnownLoaded: ["gpt-4o"],
    });
    const registry = makeFakeRegistry([record]);
    const entry = await computeActiveEntry(registry, { provider: "cloud", id: "gpt-4o" });

    expect(entry?.source).toBe("last-known");
    expect(entry?.loaded).toBe(true);
    expect(entry?.modelId).toBe("gpt-4o");

    __testAdapterMap.delete("openai");
  });

  it("uses last-known empty when no lastKnownLoaded and non-introspect", async () => {
    __testAdapterMap.set("vllm", makeNonIntrospectableAdapter("vllm"));

    const record = makeRecord({
      id: "v1",
      kind: "vllm",
      label: "vLLM",
      enabled: true,
    });
    const registry = makeFakeRegistry([record]);
    const entry = await computeActiveEntry(registry, { provider: "v1", id: "any" });

    expect(entry?.source).toBe("last-known");
    expect(entry?.loaded).toBe(false);

    __testAdapterMap.delete("vllm");
  });

  it("degrades to last-known (using record.lastKnownLoaded) when introspect throws", async () => {
    __testAdapterMap.set("ollama", makeIntrospectableAdapter("ollama", new Error("boom")));

    const record = makeRecord({
      id: "r1",
      kind: "ollama",
      label: "Ollama",
      enabled: true,
      lastKnownLoaded: ["cached-m"],
    });
    const registry = makeFakeRegistry([record]);
    const entry = await computeActiveEntry(registry, { provider: "r1", id: "cached-m" });

    expect(entry?.source).toBe("last-known");
    expect(entry?.loaded).toBe(true);
    expect(entry?.modelId).toBe("cached-m");

    __testAdapterMap.delete("ollama");
  });

  it("never throws and returns last-known shape on introspection failure", async () => {
    __testAdapterMap.set("ollama", makeIntrospectableAdapter("ollama", new Error("fail")));

    const record = makeRecord({ id: "r1", kind: "ollama", enabled: true, lastKnownLoaded: [] });
    const registry = makeFakeRegistry([record]);

    await expect(computeActiveEntry(registry, { provider: "r1", id: "x" })).resolves.not.toBeNull();
    const entry = await computeActiveEntry(registry, { provider: "r1", id: "x" });
    expect(entry?.source).toBe("last-known");

    __testAdapterMap.delete("ollama");
  });

  it("persists live snapshot via updateHealthCache and attaches health on successful introspection for the active", async () => {
    __testAdapterMap.set(
      "ollama",
      makeIntrospectableAdapter("ollama", { loadedModelIds: ["act"], source: "introspection" }),
    );
    const record = makeRecord({ id: "r1", kind: "ollama", label: "Ollama", enabled: true });

    const loadedWrites: string[][] = [];
    const base = makeFakeRegistry([record]) as unknown as Record<string, unknown>;
    const registry = {
      ...base,
      get: (id: string) => (id === "r1" ? record : undefined),
      resolveCredential: async () => ({ mode: "none" as const }),
      updateHealthCache: (_id: string, patch: { loaded?: string[] }) => {
        if (patch.loaded) loadedWrites.push(patch.loaded);
      },
      getHealth: () => "healthy" as const,
    } as unknown as ServerRegistry;

    const entry = await computeActiveEntry(registry, { provider: "r1", id: "act" });

    expect(loadedWrites).toEqual([["act"]]);
    expect(entry?.health).toBe("healthy");
    expect(entry?.source).toBe("introspection");

    __testAdapterMap.delete("ollama");
  });

  it("skips introspection (uses last-known) for disabled record even if active", async () => {
    __testAdapterMap.set("ollama", makeIntrospectableAdapter("ollama", { loadedModelIds: ["foo"], source: "introspection" }));

    const record = makeRecord({ id: "d1", kind: "ollama", enabled: false, lastKnownLoaded: ["bar"] });
    const registry = makeFakeRegistry([record]);
    const entry = await computeActiveEntry(registry, { provider: "d1", id: "bar" });

    // Should not have called introspect (would have thrown if map not set? but mainly source)
    expect(entry?.source).toBe("last-known");
    expect(entry?.loaded).toBe(true);

    __testAdapterMap.delete("ollama");
  });
});
