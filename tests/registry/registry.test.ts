import { describe, it, expect, beforeEach } from "vitest";
import { ServerRegistry } from "../../src/registry/registry.ts";
import { serverId, envVarFor } from "../../src/registry/ids.ts";
import type { CrossbarConfigFile, ServerRecord } from "../../src/core/types.ts";
import type { CredentialStore } from "../../src/registry/persistence.ts";

// ---------------------------------------------------------------------------
// Fake in-memory CredentialStore
// ---------------------------------------------------------------------------

class FakeCredentialStore implements CredentialStore {
  private data: Map<string, string> = new Map();

  get(id: string): string | undefined {
    return this.data.get(id);
  }
  set(id: string, key: string): void {
    this.data.set(id, key);
  }
  remove(id: string): void {
    this.data.delete(id);
  }
  has(id: string): boolean {
    return this.data.has(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const persisted: CrossbarConfigFile[] = [];

function makeRegistry(store: FakeCredentialStore, now = () => 1000): ServerRegistry {
  persisted.length = 0;
  return new ServerRegistry({
    store,
    persist: async (cfg) => {
      persisted.push(structuredClone(cfg));
    },
    now,
  });
}

const ollamaRecord: ServerRecord = {
  id: "crossbar-ollama-127-0-0-1-11434",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  label: "Ollama (127.0.0.1:11434)",
  auth: "none",
  enabled: true,
  addedAt: 1000,
};

const openaiRecord: ServerRecord = {
  id: "crossbar-openai",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  label: "OpenAI",
  auth: "apiKey",
  enabled: true,
  addedAt: 1000,
};

// ---------------------------------------------------------------------------
// serverId tests (ids.ts)
// ---------------------------------------------------------------------------

describe("serverId", () => {
  it("generates stable id for local server", () => {
    const id = serverId("ollama", "http://127.0.0.1:11434");
    expect(id).toBe("crossbar-ollama-127-0-0-1-11434");
  });

  it("is deterministic — same output for same input", () => {
    const a = serverId("lmstudio", "http://localhost:1234");
    const b = serverId("lmstudio", "http://localhost:1234");
    expect(a).toBe(b);
  });

  it("cloud kinds produce flat id without host/port", () => {
    expect(serverId("openai", "https://api.openai.com/v1")).toBe("crossbar-openai");
    expect(serverId("anthropic", "https://api.anthropic.com/v1")).toBe("crossbar-anthropic");
  });

  it("different ports produce different ids", () => {
    const a = serverId("ollama", "http://127.0.0.1:11434");
    const b = serverId("ollama", "http://127.0.0.1:11435");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// envVarFor tests (ids.ts)
// ---------------------------------------------------------------------------

describe("envVarFor", () => {
  it("uppercases and converts hyphens to underscores", () => {
    expect(envVarFor("crossbar-ollama-127-0-0-1-11434")).toBe(
      "CROSSBAR_OLLAMA_127_0_0_1_11434",
    );
  });

  it("cloud id produces valid env var", () => {
    expect(envVarFor("crossbar-openai")).toBe("CROSSBAR_OPENAI");
  });
});

// ---------------------------------------------------------------------------
// ServerRegistry — list / get / add / remove / update
// ---------------------------------------------------------------------------

describe("ServerRegistry", () => {
  let store: FakeCredentialStore;
  let registry: ServerRegistry;

  beforeEach(() => {
    store = new FakeCredentialStore();
    registry = makeRegistry(store);
  });

  it("starts empty", () => {
    expect(registry.list()).toEqual([]);
  });

  it("load() populates from a config file", () => {
    registry.load({ version: 1, servers: [ollamaRecord] });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(ollamaRecord.id)).toEqual(ollamaRecord);
  });

  it("add() stores the record and persists", async () => {
    await registry.add(ollamaRecord);
    expect(registry.get(ollamaRecord.id)).toEqual(ollamaRecord);
    expect(persisted).toHaveLength(1);
  });

  it("add() stores the api key in the credential store", async () => {
    await registry.add(openaiRecord, "sk-secret");
    expect(store.get(openaiRecord.id)).toBe("sk-secret");
  });

  it("add() does NOT write api key secret to the persisted config", async () => {
    await registry.add(openaiRecord, "sk-secret");
    const last = persisted[persisted.length - 1];
    const json = JSON.stringify(last);
    // The secret value must never appear in the persisted config
    expect(json).not.toContain("sk-secret");
    // The field name "apiKey" (lowercase camel) must not appear as an object key in any server record
    // (note: the string "apiKey" also appears as the value of the `auth` field, so we parse and check structurally)
    const parsed = JSON.parse(json) as { servers: Array<Record<string, unknown>> };
    for (const record of parsed.servers) {
      expect(Object.prototype.hasOwnProperty.call(record, "apiKey")).toBe(false);
    }
  });

  it("update() patches fields", async () => {
    await registry.add(ollamaRecord);
    await registry.update(ollamaRecord.id, { enabled: false, label: "New label" });
    const r = registry.get(ollamaRecord.id);
    expect(r?.enabled).toBe(false);
    expect(r?.label).toBe("New label");
    expect(r?.kind).toBe("ollama"); // unchanged fields preserved
  });

  it("update() throws for unknown id", async () => {
    await expect(registry.update("no-such-id", { enabled: false })).rejects.toThrow();
  });

  it("remove() deletes record and credential, persists", async () => {
    await registry.add(openaiRecord, "sk-secret");
    await registry.remove(openaiRecord.id);
    expect(registry.get(openaiRecord.id)).toBeUndefined();
    expect(store.has(openaiRecord.id)).toBe(false);
    // Last persist snapshot should not contain the record
    const last = persisted[persisted.length - 1];
    expect(last?.servers).toHaveLength(0);
  });

  it("remove() is a no-op for unknown id", async () => {
    await expect(registry.remove("no-such-id")).resolves.toBeUndefined();
  });

  it("setEnabled() toggles the enabled field", async () => {
    await registry.add(ollamaRecord);
    await registry.setEnabled(ollamaRecord.id, false);
    expect(registry.get(ollamaRecord.id)?.enabled).toBe(false);
    await registry.setEnabled(ollamaRecord.id, true);
    expect(registry.get(ollamaRecord.id)?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCredential
// ---------------------------------------------------------------------------

describe("resolveCredential", () => {
  let store: FakeCredentialStore;
  let registry: ServerRegistry;

  beforeEach(() => {
    store = new FakeCredentialStore();
    registry = makeRegistry(store);
  });

  it("mode none → {mode:'none'} with no apiKey field", async () => {
    await registry.add(ollamaRecord);
    const cred = await registry.resolveCredential(ollamaRecord);
    expect(cred).toEqual({ mode: "none" });
    expect("apiKey" in cred).toBe(false);
  });

  it("mode apiKey with stored key → {mode:'apiKey', apiKey}", async () => {
    await registry.add(openaiRecord, "sk-test-key");
    const cred = await registry.resolveCredential(openaiRecord);
    expect(cred).toEqual({ mode: "apiKey", apiKey: "sk-test-key" });
  });

  it("mode apiKey with no stored key → {mode:'apiKey'} without apiKey", async () => {
    await registry.add(openaiRecord); // no key
    const cred = await registry.resolveCredential(openaiRecord);
    expect(cred.mode).toBe("apiKey");
    expect("apiKey" in cred).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateHealthCache
// ---------------------------------------------------------------------------

describe("updateHealthCache", () => {
  let store: FakeCredentialStore;
  let registry: ServerRegistry;

  beforeEach(() => {
    store = new FakeCredentialStore();
    registry = makeRegistry(store);
  });

  it("updates cached model list without persisting", async () => {
    await registry.add(ollamaRecord);
    const beforePersistCount = persisted.length;
    registry.updateHealthCache(ollamaRecord.id, {
      models: [{ id: "llama3", name: "Llama 3", input: ["text"] }],
      lastSeenAt: 9999,
    });
    expect(registry.get(ollamaRecord.id)?.lastKnownModels?.[0]?.id).toBe("llama3");
    expect(registry.get(ollamaRecord.id)?.lastSeenAt).toBe(9999);
    // Health cache must NOT trigger a persist
    expect(persisted.length).toBe(beforePersistCount);
  });

  it("is a no-op for unknown id", () => {
    expect(() =>
      registry.updateHealthCache("no-such-id", { lastSeenAt: 1 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// setLastKnownModels
// ---------------------------------------------------------------------------

describe("setLastKnownModels", () => {
  let store: FakeCredentialStore;
  let registry: ServerRegistry;

  beforeEach(() => {
    store = new FakeCredentialStore();
    registry = makeRegistry(store);
  });

  it("updates lastKnownModels and calls persist (flush)", async () => {
    await registry.add(ollamaRecord);
    const beforePersistCount = persisted.length;

    const models = [{ id: "llama3", name: "Llama 3", input: ["text"] as ("text" | "image")[] }];
    await registry.setLastKnownModels(ollamaRecord.id, models);

    expect(registry.get(ollamaRecord.id)?.lastKnownModels).toEqual(models);
    // Must have triggered exactly one additional persist
    expect(persisted.length).toBe(beforePersistCount + 1);
  });

  it("persisted config contains the updated models (round-trip)", async () => {
    await registry.add(ollamaRecord);
    const models = [
      { id: "llama3:70b", name: "Llama 3 70B", input: ["text"] as ("text" | "image")[], contextWindow: 131072, maxTokens: 4096 },
    ];

    await registry.setLastKnownModels(ollamaRecord.id, models);

    const last = persisted[persisted.length - 1];
    const savedRecord = last?.servers.find((s) => s.id === ollamaRecord.id);
    expect(savedRecord?.lastKnownModels).toEqual(models);
    expect(savedRecord?.lastKnownModels?.[0]?.id).toBe("llama3:70b");
    expect(savedRecord?.lastKnownModels?.[0]?.contextWindow).toBe(131072);
  });

  it("is a no-op (no throw, no persist) for an unknown id", async () => {
    const beforePersistCount = persisted.length;

    await expect(registry.setLastKnownModels("no-such-id", [])).resolves.toBeUndefined();
    expect(persisted.length).toBe(beforePersistCount);
  });

  it("does not affect other fields on the record", async () => {
    await registry.add({ ...ollamaRecord, label: "My Ollama", enabled: false });
    const models = [{ id: "m1", name: "M1", input: ["text"] as ("text" | "image")[] }];

    await registry.setLastKnownModels(ollamaRecord.id, models);

    const rec = registry.get(ollamaRecord.id);
    expect(rec?.label).toBe("My Ollama");
    expect(rec?.enabled).toBe(false);
    expect(rec?.lastKnownModels).toEqual(models);
  });
});

// ---------------------------------------------------------------------------
// Discovery settings — round-trip + must survive server mutations
// ---------------------------------------------------------------------------

describe("discovery settings", () => {
  let store: FakeCredentialStore;
  let registry: ServerRegistry;

  beforeEach(() => {
    store = new FakeCredentialStore();
    registry = makeRegistry(store);
  });

  it("exposes settings loaded from config", () => {
    registry.load({
      version: 1,
      servers: [],
      settings: { lanDiscovery: true, lanHosts: ["192.168.1.50"], probePorts: [11434] },
    });
    expect(registry.getSettings()).toEqual({
      lanDiscovery: true,
      lanHosts: ["192.168.1.50"],
      probePorts: [11434],
    });
  });

  it("setSettings persists and is reflected by getSettings", async () => {
    await registry.setSettings({ lanDiscovery: true, probePorts: [8080] });
    expect(registry.getSettings()).toEqual({ lanDiscovery: true, probePorts: [8080] });
    const last = persisted.at(-1);
    expect(last?.settings).toEqual({ lanDiscovery: true, probePorts: [8080] });
  });

  it("normalises an empty settings object to undefined (no settings block persisted)", async () => {
    await registry.setSettings({});
    expect(registry.getSettings()).toBeUndefined();
    expect(persisted.at(-1)?.settings).toBeUndefined();
  });

  it("preserves settings across a server mutation (regression: clobbering bug)", async () => {
    registry.load({
      version: 1,
      servers: [],
      settings: { lanDiscovery: true, lanHosts: ["nas.local"] },
    });

    // A server add must NOT drop the previously-loaded settings from disk.
    await registry.add(ollamaRecord);

    const last = persisted.at(-1);
    expect(last?.servers.map((s) => s.id)).toContain(ollamaRecord.id);
    expect(last?.settings).toEqual({ lanDiscovery: true, lanHosts: ["nas.local"] });
  });

  it("a server toggle also preserves settings", async () => {
    registry.load({ version: 1, servers: [ollamaRecord], settings: { probePorts: [1234] } });
    await registry.setEnabled(ollamaRecord.id, false);
    expect(persisted.at(-1)?.settings).toEqual({ probePorts: [1234] });
  });
});
