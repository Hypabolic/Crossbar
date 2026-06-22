/**
 * Unit tests for src/preload.ts — factory-phase cached provider preload.
 *
 * Uses a temp dir to write crossbar.json via saveConfig and then calls
 * preloadCachedProviders with a fake pi that exposes only registerProvider.
 * Verifies all plan requirements:
 *   - enabled cached no-auth registers;
 *   - disabled doesn't;
 *   - enabled without cache doesn't;
 *   - embedding-only cache doesn't;
 *   - mixed cache registers only chat models (verified via buildProviderConfig);
 *   - multiple enabled register independently;
 *   - one malformed record does not block valid records;
 *   - missing/corrupt config → zero registrations, no throw;
 *   - exact placeholder for no-auth ("crossbar-no-auth") and "$"+envVarFor(id) for keyed;
 *   - no other pi methods are used (fake pi only has registerProvider).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig } from "../src/registry/persistence.ts";
import type { CrossbarConfigFile, ModelDescriptor, ServerRecord } from "../src/core/types.ts";
import { preloadCachedProviders } from "../src/preload.ts";
import { envVarFor } from "../src/registry/ids.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Temp dir setup
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossbar-preload-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake Pi — only registerProvider is allowed
// ---------------------------------------------------------------------------

function makeFakePi() {
  const registerProvider = vi.fn();
  const pi = { registerProvider } as unknown as ExtensionAPI;
  return { pi, registerProvider };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const embeddingModel: ModelDescriptor = {
  id: "mxbai-embed-large",
  name: "Mxbai Embed Large",
  contextWindow: 512,
  maxTokens: 512,
  input: ["text"],
  reasoning: false,
  embeddings: true,
};

const ollamaRecord: ServerRecord = {
  id: "crossbar-ollama-127-0-0-1-11434",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  label: "Ollama (127.0.0.1:11434)",
  auth: "none",
  enabled: true,
  addedAt: 1000,
  lastKnownModels: [chatModel],
};

const keyedRecord: ServerRecord = {
  id: "crossbar-openai",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  label: "OpenAI",
  auth: "apiKey",
  enabled: true,
  addedAt: 1000,
  lastKnownModels: [
    {
      id: "gpt-4o",
      name: "gpt-4o",
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ["text", "image"],
      reasoning: false,
      embeddings: false,
      tools: true,
    },
  ],
};

async function writeCfg(servers: ServerRecord[]): Promise<void> {
  const cfg: CrossbarConfigFile = { version: 1, servers };
  await saveConfig(cfg, { dir });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preloadCachedProviders", () => {
  it("registers an enabled no-auth server with a cached chat model", async () => {
    await writeCfg([ollamaRecord]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[0]).toBe(ollamaRecord.id);
  });

  it("does not register a disabled server even if it has cached models", async () => {
    await writeCfg([{ ...ollamaRecord, enabled: false }]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("does not register an enabled server with no cached models", async () => {
    // Omit lastKnownModels entirely (exactOptionalPropertyTypes: true)
    const { lastKnownModels: _omit, ...recordWithoutCache } = ollamaRecord;
    await writeCfg([recordWithoutCache]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("does not register an enabled server with an empty model cache", async () => {
    await writeCfg([{ ...ollamaRecord, lastKnownModels: [] }]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("does not register when the cache contains only embedding models", async () => {
    await writeCfg([{ ...ollamaRecord, lastKnownModels: [embeddingModel] }]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("registers only chat models from a mixed cache (filters embeddings)", async () => {
    await writeCfg([{ ...ollamaRecord, lastKnownModels: [chatModel, embeddingModel] }]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).toHaveBeenCalledOnce();
    const config = registerProvider.mock.calls[0]?.[1] as { models: Array<{ id: string }> };
    const modelIds = config.models.map((m) => m.id);
    expect(modelIds).toContain(chatModel.id);
    expect(modelIds).not.toContain(embeddingModel.id);
  });

  it("registers multiple enabled servers independently", async () => {
    await writeCfg([ollamaRecord, keyedRecord]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    expect(registerProvider).toHaveBeenCalledTimes(2);
    const ids = registerProvider.mock.calls.map((c) => c[0]);
    expect(ids).toContain(ollamaRecord.id);
    expect(ids).toContain(keyedRecord.id);
  });

  it("uses 'crossbar-no-auth' as apiKey for no-auth servers", async () => {
    await writeCfg([ollamaRecord]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    const config = registerProvider.mock.calls[0]?.[1] as { apiKey: string };
    expect(config.apiKey).toBe("crossbar-no-auth");
  });

  it("uses the $ENV sentinel as apiKey for keyed servers", async () => {
    await writeCfg([keyedRecord]);
    const { pi, registerProvider } = makeFakePi();

    await preloadCachedProviders(pi, { dir });

    const config = registerProvider.mock.calls[0]?.[1] as { apiKey: string };
    const expectedSentinel = "$" + envVarFor(keyedRecord.id);
    expect(config.apiKey).toBe(expectedSentinel);
    expect(config.apiKey).toBe("$CROSSBAR_OPENAI");
  });

  it("does not throw and registers zero when the config file is missing", async () => {
    // dir exists but crossbar.json was never written
    const { pi, registerProvider } = makeFakePi();

    await expect(preloadCachedProviders(pi, { dir })).resolves.toBeUndefined();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("does not throw and registers zero when the config file is corrupt", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "crossbar.json"), "{ not valid json!!!");
    const { pi, registerProvider } = makeFakePi();

    await expect(preloadCachedProviders(pi, { dir })).resolves.toBeUndefined();
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("continues registering valid records when one record has bad lastKnownModels", async () => {
    // Construct a bad record by forcing wrong type at runtime — simulates a corrupt crossbar.json
    const badRecord = {
      ...ollamaRecord,
      id: "crossbar-ollama-bad",
      kind: "ollama" as const,
      // lastKnownModels is a non-array (will cause filter to throw at runtime)
      lastKnownModels: "not-an-array" as unknown as ModelDescriptor[],
    };
    const goodRecord = { ...ollamaRecord, id: "crossbar-ollama-127-0-0-1-11435", baseUrl: "http://127.0.0.1:11435" };
    await writeCfg([badRecord, goodRecord]);
    const { pi, registerProvider } = makeFakePi();

    await expect(preloadCachedProviders(pi, { dir })).resolves.toBeUndefined();

    // The good record should still be registered.
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[0]).toBe(goodRecord.id);
  });

  it("does not call any pi method other than registerProvider", async () => {
    await writeCfg([ollamaRecord]);
    // Create a pi proxy that throws for any unexpected method call
    const registerProvider = vi.fn();
    const pi = new Proxy({ registerProvider }, {
      get(target, prop) {
        if (prop === "registerProvider") return target.registerProvider;
        throw new Error(`Unexpected pi method accessed: ${String(prop)}`);
      },
    }) as unknown as ExtensionAPI;

    await expect(preloadCachedProviders(pi, { dir })).resolves.toBeUndefined();
    expect(registerProvider).toHaveBeenCalledOnce();
  });
});
