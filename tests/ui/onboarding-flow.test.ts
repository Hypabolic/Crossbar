import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  introspectLoaded: vi.fn(),
}));

vi.mock("../../src/adapters/index.ts", () => {
  const adapter = {
    kind: "llamacpp",
    displayName: "llama.cpp",
    defaultPorts: [8080],
    piApi: "openai-completions",
    capabilities: new Set(["listModels", "introspectLoaded"]),
    fingerprint: vi.fn(),
    listModels: adapterMocks.listModels,
    introspectLoaded: adapterMocks.introspectLoaded,
    inferenceBaseUrl: (server: { baseUrl: string }) => `${server.baseUrl}/v1`,
    toPiModel: (_server: unknown, model: { id: string; name: string }) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
    }),
  };
  return {
    adapterFor: () => adapter,
    DISCOVERY_ADAPTERS: [adapter],
  };
});

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { DiscoveredServer, ModelDescriptor, ServerRecord } from "../../src/core/types.ts";
import { ServerRegistry } from "../../src/registry/registry.ts";
import { registerServer } from "../../src/shim/provider-shim.ts";
import { openOnboarding } from "../../src/ui/onboarding.ts";

const model: ModelDescriptor = {
  id: "local-model",
  name: "Local Model",
  input: ["text"],
  reasoning: false,
};

const server: DiscoveredServer = {
  kind: "llamacpp",
  baseUrl: "http://127.0.0.1:8088",
  auth: "none",
  label: "llama.cpp (127.0.0.1:8088)",
  confidence: 1,
};

function makeRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: "crossbar-llamacpp-127-0-0-1-8088",
    kind: "llamacpp",
    baseUrl: server.baseUrl,
    label: server.label,
    auth: "none",
    enabled: true,
    addedAt: 1,
    lastKnownModels: [model],
    ...overrides,
  };
}

function makeRegistry(records: ServerRecord[] = []): ServerRegistry {
  const registry = new ServerRegistry({
    store: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    persist: vi.fn(async () => undefined),
  });
  registry.load({ version: 1, servers: records });
  return registry;
}

function makeHarness(customResults: unknown[]) {
  const registered = new Map<string, ProviderConfig>();
  const registerProvider = vi.fn((id: string, config: ProviderConfig) => {
    registered.set(id, config);
  });
  const setModel = vi.fn(async () => true);
  const pi = {
    registerProvider,
    unregisterProvider: vi.fn(),
    setModel,
  } as unknown as ExtensionAPI;

  const custom = vi.fn();
  for (const result of customResults) custom.mockResolvedValueOnce(result);

  const ctx = {
    ui: {
      custom,
      notify: vi.fn(),
      input: vi.fn(),
      select: vi.fn(),
    },
    modelRegistry: {
      find: (provider: string, modelId: string) => {
        const config = registered.get(provider);
        return config?.models?.find((entry) => entry.id === modelId);
      },
    },
  } as unknown as ExtensionCommandContext;

  return { pi, ctx, custom, registerProvider, setModel };
}

describe("openOnboarding navigation and registration", () => {
  beforeEach(() => {
    adapterMocks.listModels.mockReset();
    adapterMocks.introspectLoaded.mockReset();
    adapterMocks.listModels.mockResolvedValue([model]);
    adapterMocks.introspectLoaded.mockResolvedValue({
      loadedModelIds: [model.id],
      source: "introspection",
    });
  });

  it("returns from a server menu to the server selector without closing Crossbar", async () => {
    const record = makeRecord();
    const registry = makeRegistry([record]);
    const { pi, ctx, custom } = makeHarness([
      record.baseUrl, // server selector
      null, // Esc from manage menu
      null, // Esc from server selector
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [server] });

    expect(custom).toHaveBeenCalledTimes(3);
  });

  it("reopens management after viewing loaded models", async () => {
    const record = makeRecord();
    const registry = makeRegistry([record]);
    const { pi, ctx, custom } = makeHarness([
      record.baseUrl,
      "introspect",
      undefined, // close detail overlay
      "back",
      null,
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [server] });

    expect(adapterMocks.introspectLoaded).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledTimes(5);
  });

  it("registers a new server immediately and selects the chosen Pi model", async () => {
    const registry = makeRegistry();
    const { pi, ctx, registerProvider, setModel } = makeHarness([
      server.baseUrl,
      model.id,
      null,
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [server], initialDiscovered: [server] });

    const record = registry.list()[0]!;
    expect(record.lastKnownModels).toEqual([model]);
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[1]?.apiKey).toBe("crossbar-no-auth");
    expect(setModel).toHaveBeenCalledOnce();
  });

  it("registers when model selection is skipped without calling pi.setModel", async () => {
    const registry = makeRegistry();
    const { pi, ctx, registerProvider, setModel } = makeHarness([
      server.baseUrl,
      null,
      null,
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [server], initialDiscovered: [server] });

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(setModel).not.toHaveBeenCalled();
  });

  it("rescans without closing the server selector", async () => {
    const registry = makeRegistry();
    // Opening no longer auto-scans; only the __rescan__ action invokes discover().
    const discover = vi.fn().mockResolvedValueOnce([server]);
    const { pi, ctx, custom } = makeHarness([
      "__rescan__",
      null,
    ]);

    await openOnboarding(pi, ctx, { registry, discover, initialDiscovered: [] });

    expect(discover).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("lets you pick a model to use in Pi from a server's manage menu", async () => {
    const record = makeRecord();
    const registry = makeRegistry([record]);
    const { pi, ctx, setModel } = makeHarness([
      record.baseUrl, // server selector → open management
      "use", // manage menu → "Use a model in Pi"
      model.id, // model picker → choose model
      null, // manage menu → Esc back
      null, // server selector → Esc closes
    ]);
    // Register the provider so its model is findable in Pi (as at runtime).
    await registerServer(pi, registry, record, [model]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [] });

    expect(setModel).toHaveBeenCalledOnce();
  });

  it("persists the refreshed catalogue when re-enabling a server whose models changed", async () => {
    const record = makeRecord({ enabled: false }); // lastKnownModels: [model]
    const registry = makeRegistry([record]);
    const setLastKnownModels = vi.spyOn(registry, "setLastKnownModels");
    // Live list differs from the cached catalogue → catalogueChanged is true.
    adapterMocks.listModels.mockResolvedValue([{ ...model, id: "refreshed-model" }]);

    const { pi, ctx } = makeHarness([
      record.baseUrl, // server selector → open management
      "enable", // manage menu → enable
      null, // manage menu → Esc back to selector
      null, // server selector → Esc closes
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [] });

    expect(setLastKnownModels).toHaveBeenCalledOnce();
    expect(setLastKnownModels.mock.calls[0]?.[0]).toBe(record.id);
    expect(registry.get(record.id)?.lastKnownModels).toEqual([
      { ...model, id: "refreshed-model" },
    ]);
    expect(registry.get(record.id)?.enabled).toBe(true);
  });

  it("does not persist on enable when the catalogue is unchanged", async () => {
    const record = makeRecord({ enabled: false }); // lastKnownModels: [model]
    const registry = makeRegistry([record]);
    const setLastKnownModels = vi.spyOn(registry, "setLastKnownModels");
    adapterMocks.listModels.mockResolvedValue([model]); // same as cache

    const { pi, ctx } = makeHarness([record.baseUrl, "enable", null, null]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [] });

    expect(setLastKnownModels).not.toHaveBeenCalled();
    expect(registry.get(record.id)?.enabled).toBe(true);
  });

  it("opens discovery settings and persists a LAN toggle, then returns to the selector", async () => {
    const registry = makeRegistry();
    const { pi, ctx, custom } = makeHarness([
      "__settings__", // server selector → open settings
      "toggle-lan", // settings menu → enable LAN
      null, // settings menu → Esc back to selector
      null, // server selector → Esc closes
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [] });

    expect(registry.getSettings()?.lanDiscovery).toBe(true);
    expect(custom).toHaveBeenCalledTimes(4);
  });

  it("rejects embedding-only servers and returns to the selector", async () => {
    adapterMocks.listModels.mockResolvedValue([
      { ...model, id: "embedding-model", embeddings: true },
    ]);
    const registry = makeRegistry();
    const { pi, ctx, registerProvider, custom } = makeHarness([
      server.baseUrl,
      null,
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [server], initialDiscovered: [server] });

    expect(registerProvider).not.toHaveBeenCalled();
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("manages probe ports via overlay (remove one port from custom list)", async () => {
    const registry = makeRegistry();
    // Seed a custom override (setSettings is public and uses the mock persist).
    await registry.setSettings({ probePorts: [11434, 8080, 5000] });

    const { pi, ctx, custom } = makeHarness([
      "__settings__", // server → settings
      "edit-ports",   // settings → ports overlay
      "port:11434",   // ports → remove 11434; re-renders ports list
      "back",         // ports → back to settings
      null,           // settings → back to server selector
      null,           // server selector closes
    ]);

    await openOnboarding(pi, ctx, { registry, discover: async () => [], initialDiscovered: [] });

    const after = registry.getSettings();
    expect(after?.probePorts).toEqual([8080, 5000]); // removed first, order preserved from effective
    // customs: server, settings, ports1, ports2, settings2, server2
    expect(custom).toHaveBeenCalledTimes(6);
  });
});
