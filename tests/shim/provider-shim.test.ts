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
 *   - The apiKey field is always the env-var sentinel form ("$CROSSBAR_...").
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { buildProviderConfig, registerServer, unregisterServer, reRegisterServer } from "../../src/shim/provider-shim.ts";
import { ollamaAdapter } from "../../src/adapters/ollama.ts";
import { openaiAdapter } from "../../src/adapters/openai.ts";
import { envVarFor } from "../../src/registry/ids.ts";
import type { ServerRecord, DiscoveredServer, ModelDescriptor } from "../../src/core/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

  it("apiKey is always the $ENV sentinel (not plaintext, not undefined)", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    const expectedSentinel = "$" + envVarFor(ollamaRecord.id);
    expect(cfg.apiKey).toBe(expectedSentinel);
    // CROSSBAR_OLLAMA_127_0_0_1_11434
    expect(cfg.apiKey).toMatch(/^\$CROSSBAR_/);
  });

  it("no-auth: apiKey sentinel does NOT contain any literal key value", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel], { hasApiKey: false });
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
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    expect(cfg.api).toBe("openai-completions");
  });

  it("uses the env-var sentinel as apiKey — never the literal key", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    const expectedSentinel = "$" + envVarFor(openaiRecord.id);
    expect(cfg.apiKey).toBe(expectedSentinel);
    // $CROSSBAR_OPENAI
    expect(cfg.apiKey).toBe("$CROSSBAR_OPENAI");
  });

  it("no plaintext key in serialised output even when hasApiKey=true", () => {
    const secretKey = "sk-proj-supersecret-12345";
    // A caller might pass `hasApiKey: true`; the plaintext must NOT be embedded in config
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    const serialised = JSON.stringify(cfg);
    expect(serialised).not.toContain(secretKey);
    // The apiKey field in the output is the $ENV reference, not a real key
    expect(serialised).not.toMatch(/sk-[a-zA-Z0-9]/);
  });

  it("excludes embedding models", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel, openaiEmbedModel], { hasApiKey: true });
    const ids = (cfg.models ?? []).map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("text-embedding-3-large");
  });

  it("model entries are valid PiModelEntry shapes", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
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
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    expect(cfg.baseUrl).toBe(openaiAdapter.inferenceBaseUrl(openaiServer));
  });

  it("name matches record.label", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    expect(cfg.name).toBe("OpenAI");
  });
});

// ---------------------------------------------------------------------------
// buildProviderConfig — env var sentinel contract
// ---------------------------------------------------------------------------

describe("apiKey sentinel derivation", () => {
  it("sentinel for ollama local is $CROSSBAR_OLLAMA_127_0_0_1_11434", () => {
    const cfg = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    expect(cfg.apiKey).toBe("$CROSSBAR_OLLAMA_127_0_0_1_11434");
  });

  it("sentinel for openai cloud is $CROSSBAR_OPENAI", () => {
    const cfg = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    expect(cfg.apiKey).toBe("$CROSSBAR_OPENAI");
  });

  it("sentinel always starts with $CROSSBAR_", () => {
    const cfg1 = buildProviderConfig(ollamaRecord, ollamaServer, [chatModel]);
    const cfg2 = buildProviderConfig(openaiRecord, openaiServer, [gpt4oModel], { hasApiKey: true });
    expect(cfg1.apiKey).toMatch(/^\$CROSSBAR_/);
    expect(cfg2.apiKey).toMatch(/^\$CROSSBAR_/);
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
