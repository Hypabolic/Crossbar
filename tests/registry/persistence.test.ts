import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    expect(config).toEqual({ version: 1, servers: [] });
  });

  it("returns empty config when file is not valid JSON", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "crossbar.json"), "not json");
    const config = await loadConfig({ dir });
    expect(config).toEqual({ version: 1, servers: [] });
  });

  it("returns empty config when version is wrong", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify({ version: 2, servers: [] }));
    const config = await loadConfig({ dir });
    expect(config).toEqual({ version: 1, servers: [] });
  });

  it("round-trips a valid config", async () => {
    const original: CrossbarConfigFile = { version: 1, servers: [minimalRecord] };
    await saveConfig(original, { dir });
    const loaded = await loadConfig({ dir });
    expect(loaded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe("saveConfig", () => {
  it("writes pretty-printed JSON", async () => {
    await saveConfig({ version: 1, servers: [minimalRecord] }, { dir });
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(dir, "crossbar.json"), "utf-8");
    // Pretty JSON has newlines
    expect(text).toContain("\n");
  });

  it("strips apiKey fields from server records", async () => {
    // Simulate a leaked apiKey on the record (unsafe cast intentional for test)
    const leaky = { ...minimalRecord, apiKey: "sk-secret-key" } as ServerRecord & {
      apiKey: string;
    };
    await saveConfig({ version: 1, servers: [leaky as unknown as ServerRecord] }, { dir });

    const { readFileSync } = await import("node:fs");
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
    expect(loaded).toEqual({ version: 1, servers: [] });
  });
});
