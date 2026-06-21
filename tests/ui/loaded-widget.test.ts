/**
 * Unit tests for src/ui/loaded-widget.ts
 *
 * Tests cover the two pure functions:
 *   - formatLoadedStatus: formatting, markers, (last-known) suffix, empty state.
 *   - computeLoadedEntries: introspection path, last-known fallback, per-server failure isolation.
 *
 * No Pi runtime, no network I/O, no filesystem.
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatLoadedStatus,
  computeLoadedEntries,
  type LoadedEntry,
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
// formatLoadedStatus
// ---------------------------------------------------------------------------

describe("formatLoadedStatus", () => {
  it("returns 'no servers' for an empty entry list", () => {
    expect(formatLoadedStatus([], fakeTheme)).toBe("no servers");
  });

  it("uses filled marker (●) for introspection source", () => {
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: ["llama3.1"], source: "introspection" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("●");
    expect(result).toContain("Ollama:llama3.1");
    expect(result).not.toContain("(last-known)");
  });

  it("uses clock marker (◷) and appends (last-known) for last-known source", () => {
    const entries: LoadedEntry[] = [
      { label: "vLLM", loaded: ["qwen"], source: "last-known" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("◷");
    expect(result).toContain("vLLM:qwen");
    expect(result).toContain("(last-known)");
  });

  it("uses clock marker (◷) and appends (last-known) for unknown source", () => {
    const entries: LoadedEntry[] = [
      { label: "Generic", loaded: ["model-x"], source: "unknown" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("◷");
    expect(result).toContain("(last-known)");
  });

  it("renders multiple servers separated by double-space", () => {
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: ["llama3.1"], source: "introspection" },
      { label: "vLLM", loaded: ["qwen"], source: "last-known" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("Ollama:llama3.1");
    expect(result).toContain("vLLM:qwen");
    // Two server sections joined by "  "
    expect(result).toMatch(/Ollama:llama3\.1\s{2}.*vLLM:qwen/);
  });

  it("renders idle entry for introspection with empty loaded list", () => {
    const entries: LoadedEntry[] = [
      { label: "LM Studio", loaded: [], source: "introspection" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("LM Studio:idle");
    expect(result).not.toContain("(last-known)");
  });

  it("renders idle entry with (last-known) for last-known with empty loaded list", () => {
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: [], source: "last-known" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("Ollama:idle");
    expect(result).toContain("(last-known)");
  });

  it("renders multiple loaded models per server as separate parts", () => {
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: ["modelA", "modelB"], source: "introspection" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("Ollama:modelA");
    expect(result).toContain("Ollama:modelB");
  });

  it("calls theme.fg for theming (not raw ANSI)", () => {
    const themeWithSpy = {
      fg: vi.fn((_token: string, text: string) => text),
    };
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: ["llama3.1"], source: "introspection" },
    ];
    formatLoadedStatus(entries, themeWithSpy);
    expect(themeWithSpy.fg).toHaveBeenCalled();
    // All calls must pass a string token, never raw ANSI
    for (const call of themeWithSpy.fg.mock.calls) {
      const token = call[0] as string;
      expect(typeof token).toBe("string");
      expect(token).not.toMatch(/\\x1b|\x1b/);
    }
  });

  it("surfaces an unreachable server instead of its (stale) loaded models", () => {
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: ["llama3.1"], source: "last-known", health: "unreachable" },
    ];
    const result = formatLoadedStatus(entries, fakeTheme);
    expect(result).toContain("Ollama:unreachable");
    expect(result).not.toContain("llama3.1");
  });

  it("shows an auth indicator for unauthorized servers", () => {
    const entries: LoadedEntry[] = [
      { label: "vLLM", loaded: [], source: "last-known", health: "unauthorized" },
    ];
    expect(formatLoadedStatus(entries, fakeTheme)).toContain("vLLM:auth");
  });

  it("shows live models normally when health is healthy", () => {
    const entries: LoadedEntry[] = [
      { label: "Ollama", loaded: ["llama3.1"], source: "introspection", health: "healthy" },
    ];
    expect(formatLoadedStatus(entries, fakeTheme)).toContain("Ollama:llama3.1");
  });
});

// ---------------------------------------------------------------------------
// Helpers for computeLoadedEntries
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
 * Only the methods computeLoadedEntries calls are implemented.
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
    // Remaining methods are stubs that should never be called in these tests
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
    // computeLoadedEntries persists the live snapshot and reads health; both are
    // exercised here, so provide working no-op/empty implementations.
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
// computeLoadedEntries — module-level mock of adapter resolution
// ---------------------------------------------------------------------------

// We mock the adapters/index.ts module so computeLoadedEntries uses our fake adapters.
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
// computeLoadedEntries tests
// ---------------------------------------------------------------------------

describe("computeLoadedEntries", () => {
  it("returns empty array when no enabled servers", async () => {
    const registry = makeFakeRegistry([]);
    const entries = await computeLoadedEntries(registry);
    expect(entries).toEqual([]);
  });

  it("skips disabled servers", async () => {
    const record = makeRecord({ id: "r1", kind: "ollama", enabled: false });
    const registry = makeFakeRegistry([record]);
    const entries = await computeLoadedEntries(registry);
    expect(entries).toHaveLength(0);
  });

  it("uses introspection when adapter canIntrospect and succeeds", async () => {
    const loadedState: LoadedState = {
      loadedModelIds: ["llama3.1"],
      source: "introspection",
    };
    __testAdapterMap.set("ollama", makeIntrospectableAdapter("ollama", loadedState));

    const record = makeRecord({ id: "r1", kind: "ollama", label: "Ollama", enabled: true });
    const registry = makeFakeRegistry([record]);
    const entries = await computeLoadedEntries(registry);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.source).toBe("introspection");
    expect(entry?.loaded).toEqual(["llama3.1"]);
    expect(entry?.label).toBe("Ollama");

    __testAdapterMap.delete("ollama");
  });

  it("falls back to last-known when adapter does NOT canIntrospect", async () => {
    __testAdapterMap.set("openai", makeNonIntrospectableAdapter("openai"));

    const record = makeRecord({
      id: "r2",
      kind: "openai",
      label: "OpenAI",
      enabled: true,
      lastKnownLoaded: ["gpt-4o"],
    });
    const registry = makeFakeRegistry([record]);
    const entries = await computeLoadedEntries(registry);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.source).toBe("last-known");
    expect(entry?.loaded).toEqual(["gpt-4o"]);

    __testAdapterMap.delete("openai");
  });

  it("falls back to empty loaded list when last-known is undefined", async () => {
    __testAdapterMap.set("vllm", makeNonIntrospectableAdapter("vllm"));

    const record = makeRecord({
      id: "r3",
      kind: "vllm",
      label: "vLLM",
      enabled: true,
      // no lastKnownLoaded
    });
    const registry = makeFakeRegistry([record]);
    const entries = await computeLoadedEntries(registry);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.loaded).toEqual([]);
    expect(entries[0]?.source).toBe("last-known");

    __testAdapterMap.delete("vllm");
  });

  it("isolates per-server failure: failed server degrades to last-known, others succeed", async () => {
    const failingAdapter = makeIntrospectableAdapter("ollama", new Error("network error"));
    const successAdapter = makeIntrospectableAdapter("lmstudio", {
      loadedModelIds: ["mistral"],
      source: "introspection",
    });

    __testAdapterMap.set("ollama", failingAdapter);
    __testAdapterMap.set("lmstudio", successAdapter);

    const records = [
      makeRecord({
        id: "r1",
        kind: "ollama",
        label: "Ollama",
        enabled: true,
        lastKnownLoaded: ["cached-model"],
      }),
      makeRecord({
        id: "r2",
        kind: "lmstudio",
        label: "LM Studio",
        baseUrl: "http://127.0.0.1:1234",
        enabled: true,
      }),
    ];
    const registry = makeFakeRegistry(records);

    const entries = await computeLoadedEntries(registry);

    expect(entries).toHaveLength(2);

    const ollamaEntry = entries.find((e) => e.label === "Ollama");
    const lmEntry = entries.find((e) => e.label === "LM Studio");

    // Ollama failed: degrades to last-known
    expect(ollamaEntry?.source).toBe("last-known");
    expect(ollamaEntry?.loaded).toEqual(["cached-model"]);

    // LM Studio succeeded via introspection
    expect(lmEntry?.source).toBe("introspection");
    expect(lmEntry?.loaded).toEqual(["mistral"]);

    __testAdapterMap.delete("ollama");
    __testAdapterMap.delete("lmstudio");
  });

  it("never throws even when all servers fail", async () => {
    __testAdapterMap.set("ollama", makeIntrospectableAdapter("ollama", new Error("all fail")));

    const record = makeRecord({ id: "r1", kind: "ollama", enabled: true });
    const registry = makeFakeRegistry([record]);

    await expect(computeLoadedEntries(registry)).resolves.toHaveLength(1);
    const entries = await computeLoadedEntries(registry);
    expect(entries[0]?.source).toBe("last-known");

    __testAdapterMap.delete("ollama");
  });

  it("persists the live snapshot to the cache and attaches polled health", async () => {
    __testAdapterMap.set(
      "ollama",
      makeIntrospectableAdapter("ollama", { loadedModelIds: ["llama3.1"], source: "introspection" }),
    );
    const record = makeRecord({ id: "r1", kind: "ollama", label: "Ollama", enabled: true });

    const loadedWrites: string[][] = [];
    const base = makeFakeRegistry([record]) as unknown as Record<string, unknown>;
    const registry = {
      ...base,
      list: () => [record],
      resolveCredential: async () => ({ mode: "none" as const }),
      updateHealthCache: (_id: string, patch: { loaded?: string[] }) => {
        if (patch.loaded) loadedWrites.push(patch.loaded);
      },
      getHealth: () => "degraded" as const,
      setHealth: () => {},
    } as unknown as ServerRegistry;

    const entries = await computeLoadedEntries(registry);

    expect(loadedWrites).toEqual([["llama3.1"]]); // live snapshot persisted
    expect(entries[0]?.health).toBe("degraded"); // polled health attached

    __testAdapterMap.delete("ollama");
  });
});
