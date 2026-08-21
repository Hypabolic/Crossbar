import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig } from "../../src/registry/persistence.ts";
import type { CrossbarConfigFile, ServerRecord } from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossbar-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const minimalRecord: ServerRecord = {
  id: "crossbar-ollama-127-0-0-1-11434",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  label: "Ollama (127.0.0.1:11434)",
  auth: "none",
  enabled: true,
  addedAt: 1000,
};

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("returns empty config when file does not exist", async () => {
    const config = await loadConfig({ dir });
    expect(config).toEqual({ version: 1, modelCacheVersion: 2, servers: [] });
  });

  it("returns empty config when file is not valid JSON", async () => {
    writeFileSync(join(dir, "crossbar.json"), "not json");
    const config = await loadConfig({ dir });
    expect(config).toEqual({ version: 1, modelCacheVersion: 2, servers: [] });
  });

  it("returns empty config when version is wrong", async () => {
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify({ version: 2, servers: [] }));
    const config = await loadConfig({ dir });
    expect(config).toEqual({ version: 1, modelCacheVersion: 2, servers: [] });
  });

  it("round-trips a valid config", async () => {
    const original: CrossbarConfigFile = {
      version: 1,
      modelCacheVersion: 2,
      servers: [minimalRecord],
    };
    await saveConfig(original, { dir });
    const loaded = await loadConfig({ dir });
    expect(loaded).toEqual(original);
  });

  it.each([
    ["missing", undefined],
    ["invalid", 1],
  ])("migrates legacy llama-swap fallbacks without stripping positive llama.cpp context with a %s marker", async (_label, marker) => {
    const settings = { lanDiscovery: true, probePorts: [8080, 8081] };
    const legacy = {
      version: 1,
      ...(marker === undefined ? {} : { modelCacheVersion: marker }),
      settings,
      servers: [
        {
          ...minimalRecord,
          id: "legacy-swap",
          kind: "llamaswap",
          lastKnownLoaded: ["swap-context-fallback"],
          lastKnownModels: [
            {
              id: "swap-context-fallback",
              name: "Swap context fallback",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 2048,
              tools: true,
            },
            {
              id: "swap-max-fallback",
              name: "Swap max fallback",
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "legacy-cpp",
          kind: "llamacpp",
          lastKnownModels: [
            {
              id: "cpp-authoritative-context",
              name: "Cpp authoritative context",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 2048,
            },
            {
              id: "cpp-max-fallback",
              name: "Cpp max fallback",
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 4096,
            },
            {
              id: "cpp-invalid-context",
              name: "Cpp invalid context",
              input: ["text"],
              contextWindow: 0,
              maxTokens: 1024,
              reasoning: true,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "legacy-unsloth",
          kind: "unsloth",
          lastKnownModels: [
            {
              // Unsloth reports context fields only for LOADED models; unloaded ones got the
              // adapter's invented 8192/4096 frozen into the cache.
              id: "unsloth-fabricated",
              name: "Unsloth fabricated",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 4096,
              loaded: false,
            },
            {
              id: "unsloth-authoritative",
              name: "Unsloth authoritative",
              input: ["text"],
              contextWindow: 262144,
              maxTokens: 131072,
              loaded: true,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "unaffected-ollama",
          lastKnownModels: [
            {
              id: "ollama-legitimate",
              name: "Ollama legitimate",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      ],
    };
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify(legacy));

    const loaded = await loadConfig({ dir });

    expect(loaded).toEqual({
      version: 1,
      modelCacheVersion: 2,
      settings,
      servers: [
        {
          ...minimalRecord,
          id: "legacy-swap",
          kind: "llamaswap",
          lastKnownLoaded: ["swap-context-fallback"],
          lastKnownModels: [
            {
              id: "swap-context-fallback",
              name: "Swap context fallback",
              input: ["text"],
              maxTokens: 2048,
              tools: true,
            },
            {
              id: "swap-max-fallback",
              name: "Swap max fallback",
              input: ["text"],
              contextWindow: 32768,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "legacy-cpp",
          kind: "llamacpp",
          lastKnownModels: [
            {
              id: "cpp-authoritative-context",
              name: "Cpp authoritative context",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 2048,
            },
            {
              id: "cpp-max-fallback",
              name: "Cpp max fallback",
              input: ["text"],
              contextWindow: 32768,
            },
            {
              id: "cpp-invalid-context",
              name: "Cpp invalid context",
              input: ["text"],
              maxTokens: 1024,
              reasoning: true,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "legacy-unsloth",
          kind: "unsloth",
          lastKnownModels: [
            {
              id: "unsloth-fabricated",
              name: "Unsloth fabricated",
              input: ["text"],
              loaded: false,
            },
            {
              id: "unsloth-authoritative",
              name: "Unsloth authoritative",
              input: ["text"],
              contextWindow: 262144,
              maxTokens: 131072,
              loaded: true,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "unaffected-ollama",
          lastKnownModels: [
            {
              id: "ollama-legitimate",
              name: "Ollama legitimate",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      ],
    });
  });

  it("trusts current-marker model caches without re-migrating legitimate fallback-shaped values", async () => {
    const marked: CrossbarConfigFile = {
      version: 1,
      modelCacheVersion: 2,
      servers: [
        {
          ...minimalRecord,
          id: "marked-swap",
          kind: "llamaswap",
          lastKnownModels: [
            {
              id: "swap-legitimate",
              name: "Swap legitimate",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
        {
          ...minimalRecord,
          id: "marked-cpp",
          kind: "llamacpp",
          lastKnownModels: [
            {
              id: "cpp-legitimate",
              name: "Cpp legitimate",
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      ],
    };
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify(marked));

    expect(await loadConfig({ dir })).toEqual(marked);
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe("saveConfig", () => {
  it("writes pretty-printed JSON", async () => {
    await saveConfig({ version: 1, servers: [minimalRecord] }, { dir });
    const text = readFileSync(join(dir, "crossbar.json"), "utf-8");
    // Pretty JSON has newlines
    expect(text).toContain("\n");
    expect(JSON.parse(text)).toMatchObject({ version: 1, modelCacheVersion: 2 });
  });

  it("strips apiKey fields from server records", async () => {
    // Simulate a leaked apiKey on the record (unsafe cast intentional for test)
    const leaky = { ...minimalRecord, apiKey: "sk-secret-key" } as ServerRecord & {
      apiKey: string;
    };
    await saveConfig({ version: 1, servers: [leaky as unknown as ServerRecord] }, { dir });

    const text = readFileSync(join(dir, "crossbar.json"), "utf-8");
    expect(text).not.toContain("sk-secret-key");
    expect(text).not.toContain("apiKey");
  });

  it("preserves non-secret fields across save/load", async () => {
    const record: ServerRecord = {
      ...minimalRecord,
      lastKnownModels: [
        { id: "llama3", name: "Llama 3", input: ["text"] },
      ],
    };
    await saveConfig({ version: 1, servers: [record] }, { dir });
    const loaded = await loadConfig({ dir });
    expect(loaded.servers[0]?.lastKnownModels?.[0]?.id).toBe("llama3");
  });

  it("creates the directory if it does not exist", async () => {
    const nested = join(dir, "nested", "deep");
    await saveConfig({ version: 1, servers: [] }, { dir: nested });
    const loaded = await loadConfig({ dir: nested });
    expect(loaded).toEqual({ version: 1, modelCacheVersion: 2, servers: [] });
  });
});

// ---------------------------------------------------------------------------
// Atomicity — concurrent readers must never observe a partial/torn file
// ---------------------------------------------------------------------------

describe("saveConfig atomicity", () => {
  /** N distinct, non-empty records so a snapshot's server count identifies it. */
  function recordsOfLength(n: number): ServerRecord[] {
    return Array.from({ length: n }, (_, i) => ({
      ...minimalRecord,
      id: `crossbar-ollama-host-${i}`,
      baseUrl: `http://127.0.0.1:${11434 + i}`,
    }));
  }

  it("concurrent readers never observe a partial/corrupt file", async () => {
    // The temp-file + atomic rename in saveConfig must guarantee that every
    // reader sees either the old or the new COMPLETE file, never a half-written
    // one. A torn read would fail JSON.parse and loadConfig would fall back to
    // the empty config (0 servers) — which we never write, so it's detectable.
    const writeLengths = [1, 2, 3];

    // Seed a valid file so the very first readers have a complete snapshot.
    await saveConfig({ version: 1, servers: recordsOfLength(1) }, { dir });

    const writers = Array.from({ length: 40 }, (_, i) =>
      saveConfig(
        { version: 1, servers: recordsOfLength(writeLengths[i % writeLengths.length]!) },
        { dir },
      ),
    );
    const readers = Array.from({ length: 150 }, () => loadConfig({ dir }));

    const [, ...reads] = await Promise.all([Promise.all(writers), ...readers]);

    for (const cfg of reads as CrossbarConfigFile[]) {
      expect(cfg.version).toBe(1);
      expect(Array.isArray(cfg.servers)).toBe(true);
      // Must equal one of the committed snapshots — never the 0-length empty
      // fallback that a partial read would produce.
      expect(writeLengths).toContain(cfg.servers.length);
    }
  });
});
