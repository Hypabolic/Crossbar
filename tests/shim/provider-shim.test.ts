/**
 * Unit tests for the provider-registration shim.
 *
 * Tests buildProviderConfig with real adapter instances and hand-built
 * ServerRecord / DiscoveredServer / ModelDescriptor arrays.
 *
 * Hard rules verified:
 *   - Embedding models are filtered out — never appear in Pi models[].
 *   - Every output model is a valid PiModelEntry shape.
 *   - No plaintext API key appears anywhere in the output.
 *   - Keyed providers use the env-var sentinel form ("$CROSSBAR_...").
 *   - No-auth providers use a resolved, non-secret placeholder key.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { buildProviderConfig, registerCachedServer, registerServer, unregisterServer, reRegisterServer } from "../../src/shim/provider-shim.ts";
import { ollamaAdapter } from "../../src/adapters/ollama.ts";
import { openaiAdapter } from "../../src/adapters/openai.ts";
import { envVarFor } from "../../src/registry/ids.ts";
import type { ServerRecord, DiscoveredServer, ModelDescriptor } from "../../src/core/types.ts";
import {
  AuthStorage,
  ModelRegistry,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { ServerRegistry } from "../../src/registry/registry.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A local Ollama server — no auth. */
const ollamaRecord: ServerRecord = {
  id: "crossbar-ollama-127-0-0-1-11434",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  label: "Ollama (127.0.0.1:11434)",
  auth: "none",
  enabled: true,
  addedAt: 1000,
};

const ollamaServer: DiscoveredServer = {
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  auth: "none",
  label: "Ollama (127.0.0.1:11434)",
  confidence: 0.95,
};

/** An OpenAI cloud server — requires an API key. */
const openaiRecord: ServerRecord = {
  id: "crossbar-openai",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  label: "OpenAI",
  auth: "apiKey",
  enabled: true,
  addedAt: 1000,
};

const openaiServer: DiscoveredServer = {
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  auth: "apiKey",
  label: "OpenAI",
  confidence: 1,
};

/** Chat model (should be included). */
const chatModel: ModelDescriptor = {
  id: "llama3:8b",
  name: "Llama 3 8B",
  contextWindow: 8192,
  maxTokens: 4096,
  input: ["text"],
  reasoning: false,
  tools: true,
  embeddings: false,
};

/** Vision model (should be included). */
const visionModel: ModelDescriptor = {
  id: "llava:7b",
  name: "LLaVA 7B",
  contextWindow: 4096,
  maxTokens: 2048,
  input: ["text", "image"],
  reasoning: false,
  tools: false,
  embeddings: false,
};

/** Embedding model (must be EXCLUDED from Pi registration). */
const embeddingModel: ModelDescriptor = {
  id: "mxbai-embed-large",
  name: "Mxbai Embed Large",
  contextWindow: 512,
  maxTokens: 512,
  input: ["text"],
  reasoning: false,
  embeddings: true,
};

/** OpenAI GPT-4o model (cloud, with key). */
const gpt4oModel: ModelDescriptor = {
  id: "gpt-4o",
  name: "gpt-4o",
  contextWindow: 128_000,
  maxTokens: 16_384,
  input: ["text", "image"],
  reasoning: false,
  embeddings: false,
  tools: true,
};

/** OpenAI text-embedding model (must be excluded). */
const openaiEmbedModel: ModelDescriptor = {
  id: "text-embedding-3-large",
  name: "text-embedding-3-large",
  contextWindow: 8192,
  maxTokens: 8192,
  input: ["text"],
  reasoning: false,
  embeddings: true,
};

// ---------------------------------------------------------------------------
// buildProviderConfig — Ollama (local, no auth)
// ---------------------------------------------------------------------------

describe("buildProviderConfig — Ollama local no-auth", () => {
  it("sets name from record.label", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    expect(cfg.name).toBe(ollamaRecord.label);
  });

  it("sets baseUrl from adapter.inferenceBaseUrl", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    expect(cfg.baseUrl).toBe(ollamaAdapter.inferenceBaseUrl(ollamaServer));
    // Ollama appends /v1
    expect(cfg.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("sets api from adapter.piApi (openai-completions)", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    expect(cfg.api).toBe("openai-completions");
  });

  it("includes chat models in output", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel, visionModel]);
    expect(cfg.models).toHaveLength(2);
  });

  it("EXCLUDES embedding models from output", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel, embeddingModel, visionModel]);
    const ids = (cfg.models ?? []).map((m) => m.id);
    expect(ids).not.toContain(embeddingModel.id);
    expect(ids).toContain(chatModel.id);
    expect(ids).toContain(visionModel.id);
  });

  it("produces a valid PiModelEntry shape for every model", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel, visionModel]);
    for (const model of cfg.models ?? []) {
      expect(typeof model.id).toBe("string");
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.name).toBe("string");
      expect(typeof model.reasoning).toBe("boolean");
      expect(Array.isArray(model.input)).toBe(true);
      expect(typeof model.cost).toBe("object");
      expect(typeof model.cost.input).toBe("number");
      expect(typeof model.cost.output).toBe("number");
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.maxTokens).toBe("number");
    }
  });

  it("uses a resolved placeholder API key so Pi permits requests", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    expect(cfg.apiKey).toBe("crossbar-no-auth");
  });

  it("no-auth: placeholder does NOT contain any literal key value", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    // The output must never contain a real API key in plaintext
    const serialised = JSON.stringify(cfg);
    expect(serialised).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(serialised).not.toMatch(/Bearer /);
  });

  it("with empty model list, models array is empty", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, []);
    expect(cfg.models).toEqual([]);
  });

  it("with only embedding models, models array is empty", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [embeddingModel]);
    expect(cfg.models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildProviderConfig — OpenAI cloud with API key
// ---------------------------------------------------------------------------

describe("buildProviderConfig — OpenAI cloud with key", () => {
  it("sets correct api type (openai-completions)", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    expect(cfg.api).toBe("openai-completions");
  });

  it("uses the env-var sentinel as apiKey — never the literal key", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    const expectedSentinel = "$" + envVarFor(openaiRecord.id);
    expect(cfg.apiKey).toBe(expectedSentinel);
    // $CROSSBAR_OPENAI
    expect(cfg.apiKey).toBe("$CROSSBAR_OPENAI");
  });

  it("never includes a plaintext key in the serialised provider config", () => {
    const secretKey = "sk-proj-supersecret-12345";
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    const serialised = JSON.stringify(cfg);
    expect(serialised).not.toContain(secretKey);
    // The apiKey field in the output is the $ENV reference, not a real key
    expect(serialised).not.toMatch(/sk-[a-zA-Z0-9]/);
  });

  it("excludes embedding models", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel, openaiEmbedModel]);
    const ids = (cfg.models ?? []).map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("text-embedding-3-large");
  });

  it("model entries are valid PiModelEntry shapes", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    for (const model of cfg.models ?? []) {
      expect(typeof model.id).toBe("string");
      expect(typeof model.name).toBe("string");
      expect(typeof model.reasoning).toBe("boolean");
      expect(Array.isArray(model.input)).toBe(true);
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.maxTokens).toBe("number");
      expect(typeof model.cost.input).toBe("number");
      expect(typeof model.cost.output).toBe("number");
      expect(typeof model.cost.cacheRead).toBe("number");
      expect(typeof model.cost.cacheWrite).toBe("number");
    }
  });

  it("baseUrl matches adapter.inferenceBaseUrl", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    expect(cfg.baseUrl).toBe(openaiAdapter.inferenceBaseUrl(openaiServer));
  });

  it("name matches record.label", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    expect(cfg.name).toBe("OpenAI");
  });
});

// ---------------------------------------------------------------------------
// buildProviderConfig — env var sentinel contract
// ---------------------------------------------------------------------------

describe("apiKey derivation", () => {
  it("placeholder for ollama local is a resolved literal", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    expect(cfg.apiKey).toBe("crossbar-no-auth");
  });

  it("sentinel for openai cloud is $CROSSBAR_OPENAI", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    expect(cfg.apiKey).toBe("$CROSSBAR_OPENAI");
  });

  it("only keyed providers use a $CROSSBAR_ sentinel", () => {
    const cfg1 = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    const cfg2 = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel]);
    expect(cfg1.apiKey).not.toMatch(/^\$CROSSBAR_/);
    expect(cfg2.apiKey).toMatch(/^\$CROSSBAR_/);
  });
});

describe("Pi request-auth integration", () => {
  it("treats a no-auth Crossbar model as available and resolves the placeholder", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const config = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);

    modelRegistry.registerProvider(ollamaRecord.id, config);
    const model = modelRegistry.find(ollamaRecord.id, chatModel.id);

    expect(model).toBeDefined();
    expect(modelRegistry.hasConfiguredAuth(model!)).toBe(true);
    await expect(modelRegistry.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: "crossbar-no-auth",
    });
  });
});

// ---------------------------------------------------------------------------
// registerServer / unregisterServer / reRegisterServer — mock ExtensionAPI
// ---------------------------------------------------------------------------

function makePi(): { pi: ExtensionAPI; registerProvider: Mock; unregisterProvider: Mock } {
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  const pi = { registerProvider, unregisterProvider } as unknown as ExtensionAPI;
  return { pi, registerProvider, unregisterProvider };
}

function makeRegistry(resolvedKey?: string): ServerRegistry {
  return {
    resolveCredential: vi.fn(async (record: ServerRecord) => {
      if (record.auth === "none") return { mode: "none" as const };
      if (resolvedKey !== undefined) return { mode: "apiKey" as const, apiKey: resolvedKey };
      return { mode: "apiKey" as const };
    }),
  } as unknown as ServerRegistry;
}

describe("registerServer", () => {
  it("calls pi.registerProvider with the record id", async () => {
    const { pi, registerProvider } = makePi();
    const registry = makeRegistry();
    await registerServer(pi, registry, ollamaRecord, [chatModel]);
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[0]).toBe(ollamaRecord.id);
  });

  it("passes a ProviderConfig with models", async () => {
    const { pi, registerProvider } = makePi();
    const registry = makeRegistry();
    await registerServer(pi, registry, ollamaRecord, [chatModel, embeddingModel]);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    // Only chat models should appear
    expect(Array.isArray(config["models"])).toBe(true);
    const models = config["models"] as Array<{ id: string }>;
    expect(models.some((m) => m.id === chatModel.id)).toBe(true);
    expect(models.some((m) => m.id === embeddingModel.id)).toBe(false);
  });

  it("apiKey in registered config is the sentinel, not the resolved plaintext key", async () => {
    const plaintextKey = "sk-realkey-should-not-appear";
    const { pi, registerProvider } = makePi();
    const registry = makeRegistry(plaintextKey);
    await registerServer(pi, registry, openaiRecord, [gpt4oModel]);
    const config = registerProvider.mock.calls[0]?.[1] as Record<string, unknown>;
    // Must be the $ENV sentinel — never the raw key
    expect(config["apiKey"]).toBe("$CROSSBAR_OPENAI");
    expect(config["apiKey"]).not.toBe(plaintextKey);
    // Serialised form must not contain the plaintext
    expect(JSON.stringify(config)).not.toContain(plaintextKey);
  });

  it("rejects a keyed server when its stored credential is missing", async () => {
    const { pi, registerProvider } = makePi();
    const registry = makeRegistry();

    await expect(registerServer(pi, registry, openaiRecord, [gpt4oModel]))
      .rejects.toThrow("API key missing");
    expect(registerProvider).not.toHaveBeenCalled();
  });
});

describe("unregisterServer", () => {
  it("calls pi.unregisterProvider with the record id", () => {
    const { pi, unregisterProvider } = makePi();
    unregisterServer(pi, ollamaRecord);
    expect(unregisterProvider).toHaveBeenCalledOnce();
    expect(unregisterProvider.mock.calls[0]?.[0]).toBe(ollamaRecord.id);
  });
});

describe("reRegisterServer", () => {
  it("calls unregister then register in order", async () => {
    const calls: string[] = [];
    const pi = {
      registerProvider: vi.fn(() => { calls.push("register"); }),
      unregisterProvider: vi.fn(() => { calls.push("unregister"); }),
    } as unknown as ExtensionAPI;
    const registry = makeRegistry();
    await reRegisterServer(pi, registry, ollamaRecord, [chatModel]);
    expect(calls).toEqual(["unregister", "register"]);
  });

  it("re-registers with the updated model list", async () => {
    const { pi, registerProvider } = makePi();
    const registry = makeRegistry();
    const updatedModels: ModelDescriptor[] = [
      { ...chatModel, id: "llama3:70b", name: "Llama 3 70B" },
    ];
    await reRegisterServer(pi, registry, ollamaRecord, updatedModels);
    const config = registerProvider.mock.calls[0]?.[1] as { models: Array<{ id: string }> };
    expect(config.models[0]?.id).toBe("llama3:70b");
  });
});

// ---------------------------------------------------------------------------
// Unit: keyed availability (plan) — uses real ModelRegistry + AuthStorage
// via registerCachedServer to exercise the exact buildProviderConfig mapping.
// ---------------------------------------------------------------------------

describe("keyed availability (real ModelRegistry + registerCachedServer)", () => {
  const keyedId = "crossbar-openai";
  const keyedModelId = "gpt-4o";
  const keyedChatModel: ModelDescriptor = gpt4oModel;

  const keyedServerRecord: ServerRecord = {
    ...openaiRecord,
    lastKnownModels: [keyedChatModel],
  };

  function makeRegisteringPi(mr: ReturnType<typeof ModelRegistry.inMemory>) {
    return {
      registerProvider: (name: string, config: any) => mr.registerProvider(name, config),
    } as unknown as ExtensionAPI;
  }

  it("keyed cached provider + stored credential → model is available (getAvailable + hasConfiguredAuth)", async () => {
    const authStorage = AuthStorage.inMemory();
    authStorage.set(keyedId, { type: "api_key", key: "sk-test-123" });
    const mr = ModelRegistry.inMemory(authStorage);
    const pi = makeRegisteringPi(mr);

    const registered = registerCachedServer(pi, keyedServerRecord, keyedServerRecord.lastKnownModels!);
    expect(registered).toBe(true);

    const model = mr.find(keyedId, keyedModelId);
    expect(model).toBeDefined();
    expect(model!.provider).toBe(keyedId);
    expect(mr.hasConfiguredAuth(model!)).toBe(true);
    expect(mr.getAvailable().some((m) => m.id === keyedModelId && m.provider === keyedId)).toBe(true);
  });

  it("keyed cached provider WITHOUT stored credential → registered but unavailable, no crash", async () => {
    const authStorage = AuthStorage.inMemory(); // deliberately no key for this id
    const mr = ModelRegistry.inMemory(authStorage);
    const pi = makeRegisteringPi(mr);

    const registered = registerCachedServer(pi, keyedServerRecord, keyedServerRecord.lastKnownModels!);
    expect(registered).toBe(true);

    const model = mr.find(keyedId, keyedModelId);
    expect(model).toBeDefined(); // still registered via sentinel
    expect(model!.provider).toBe(keyedId);
    expect(mr.hasConfiguredAuth(model!)).toBe(false);
    expect(mr.getAvailable().some((m) => m.id === keyedModelId && m.provider === keyedId)).toBe(false);
  });

  it("no-auth cached provider resolves with crossbar-no-auth and is available", async () => {
    const authStorage = AuthStorage.inMemory();
    const mr = ModelRegistry.inMemory(authStorage);
    const pi = makeRegisteringPi(mr);

    const registered = registerCachedServer(pi, ollamaRecord, [chatModel]);
    expect(registered).toBe(true);

    const model = mr.find(ollamaRecord.id, chatModel.id);
    expect(model).toBeDefined();
    expect(mr.hasConfiguredAuth(model!)).toBe(true);
    await expect(mr.getApiKeyAndHeaders(model!)).resolves.toEqual({ ok: true, apiKey: "crossbar-no-auth" });
    expect(mr.getAvailable().some((m) => m.id === chatModel.id && m.provider === ollamaRecord.id)).toBe(true);
  });

  it("keyed-without-key registration does not affect a no-auth provider", async () => {
    const authStorage = AuthStorage.inMemory(); // keyed id has no entry
    const mr = ModelRegistry.inMemory(authStorage);
    const pi = makeRegisteringPi(mr);

    registerCachedServer(pi, keyedServerRecord, keyedServerRecord.lastKnownModels!);
    registerCachedServer(pi, ollamaRecord, [chatModel]);

    const noAuthModel = mr.find(ollamaRecord.id, chatModel.id);
    const keyedModel = mr.find(keyedId, keyedModelId);

    expect(noAuthModel).toBeDefined();
    expect(keyedModel).toBeDefined();
    expect(mr.hasConfiguredAuth(noAuthModel!)).toBe(true);
    expect(mr.hasConfiguredAuth(keyedModel!)).toBe(false);
    const availableIds = mr.getAvailable().map((m) => `${m.provider}/${m.id}`);
    expect(availableIds.some((s) => s.includes(ollamaRecord.id))).toBe(true);
    expect(availableIds.some((s) => s.includes(keyedId))).toBe(false);
  });
});
