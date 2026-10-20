/**
 * Window provenance: the merge ladder and the v1/v2 → v3 model-cache
 * migration (provenance stamping, values unchanged).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeCatalogue } from "../../src/core/window-provenance.ts";
import { loadConfig, saveConfig } from "../../src/registry/persistence.ts";
import type { CrossbarConfigFile, ModelDescriptor, ServerRecord } from "../../src/core/types.ts";

const T = 1_700_000_000_000;

function model(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  const base: ModelDescriptor = { id, name: id, input: ["text"], reasoning: false };
  return { ...base, ...overrides };
}

function withWindow(m: ModelDescriptor, value: number, source: "declared" | "observed"): ModelDescriptor {
  return { ...m, contextWindow: value, contextWindowSource: source, contextWindowAt: T };
}

// ---------------------------------------------------------------------------
// mergeCatalogue — the precedence ladder
// ---------------------------------------------------------------------------

describe("mergeCatalogue — precedence ladder", () => {
  it("live observed beats persisted declared (pin removed from launch args)", () => {
    const persisted = [withWindow(model("m"), 32768, "declared")];
    const live = [withWindow(model("m"), 234496, "observed")];
    const merged = mergeCatalogue(persisted, live);
    expect(merged[0]?.contextWindow).toBe(234496);
    expect(merged[0]?.contextWindowSource).toBe("observed");
  });

  it("live declared beats persisted observed", () => {
    const persisted = [withWindow(model("m"), 234496, "observed")];
    const live = [withWindow(model("m"), 32768, "declared")];
    const merged = mergeCatalogue(persisted, live);
    expect(merged[0]?.contextWindow).toBe(32768);
    expect(merged[0]?.contextWindowSource).toBe("declared");
  });

  it("persisted observed fills an unloaded live model (value, source, and timestamp kept)", () => {
    const persisted = [withWindow(model("m"), 234496, "observed")];
    const live = [model("m")];
    const merged = mergeCatalogue(persisted, live);
    expect(merged[0]?.contextWindow).toBe(234496);
    expect(merged[0]?.contextWindowSource).toBe("observed");
    expect(merged[0]?.contextWindowAt).toBe(T);
  });

  it("persisted declared fills an unloaded live model", () => {
    const persisted = [withWindow(model("m"), 32768, "declared")];
    const live = [model("m")];
    const merged = mergeCatalogue(persisted, live);
    expect(merged[0]?.contextWindow).toBe(32768);
    expect(merged[0]?.contextWindowSource).toBe("declared");
  });

  it("no evidence anywhere stays unknown (no window, no source)", () => {
    const merged = mergeCatalogue([model("m")], [model("m")]);
    expect(merged[0]).not.toHaveProperty("contextWindow");
    expect(merged[0]).not.toHaveProperty("contextWindowSource");
  });

  it("live live-caps (name, tools) win over the persisted cache", () => {
    const persisted = [withWindow(model("m", { name: "Old", tools: true }), 8192, "observed")];
    const live = [model("m", { name: "New", tools: false })];
    const merged = mergeCatalogue(persisted, live);
    expect(merged[0]?.name).toBe("New");
    expect(merged[0]?.tools).toBe(false);
    expect(merged[0]?.contextWindow).toBe(8192); // window still filled from cache
  });

  it("trainedMax: live value wins, otherwise the persisted value fills", () => {
    const persisted = [
      { ...withWindow(model("a"), 8192, "observed"), trainedMax: 131072 },
      model("b", { trainedMax: 65536 }),
    ];
    const live = [
      { ...withWindow(model("a"), 4096, "observed"), trainedMax: 262144 },
      model("b"),
    ];
    const merged = mergeCatalogue(persisted, live);
    expect(merged[0]?.trainedMax).toBe(262144); // live wins
    expect(merged[1]?.trainedMax).toBe(65536); // persisted fills
  });

  it("live membership wins — persisted-only models are not resurrected", () => {
    const persisted = [withWindow(model("gone"), 8192, "observed")];
    const live = [withWindow(model("here"), 16384, "observed")];
    const merged = mergeCatalogue(persisted, live);
    expect(merged.map((m) => m.id)).toEqual(["here"]);
  });

  it("accepts an undefined persisted catalogue and does not mutate its inputs", () => {
    const persisted = [withWindow(model("m"), 8192, "observed")];
    const live = [model("m")];
    const before = JSON.stringify({ persisted, live });
    mergeCatalogue(persisted, live);
    mergeCatalogue(undefined, live);
    expect(JSON.stringify({ persisted, live })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// modelCacheVersion migration: v1/v2 → v3 (provenance stamping)
// ---------------------------------------------------------------------------

describe("model cache migration v1/v2 → v3", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crossbar-wp-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (kind: ServerRecord["kind"], models: ModelDescriptor[]): ServerRecord => ({
    id: `crossbar-${kind}-127-0-0-1-1`,
    kind,
    baseUrl: "http://127.0.0.1:11434",
    label: kind,
    auth: "none",
    enabled: true,
    addedAt: 1000,
    lastKnownModels: models,
  });

  it("stamps bare legacy windows as observed — values unchanged — and writes marker 3", async () => {
    const legacy: CrossbarConfigFile = {
      version: 1,
      servers: [
        record("llamacpp", [
          model("qwen", { contextWindow: 234496, maxTokens: 8192 }),
          model("other"),
        ]),
      ],
    };
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify(legacy));

    const loaded = await loadConfig({ dir });
    expect(loaded.modelCacheVersion).toBe(3);
    const [qwen, other] = loaded.servers[0]!.lastKnownModels!;
    expect(qwen!.contextWindow).toBe(234496); // value unchanged
    expect(qwen!.contextWindowSource).toBe("observed");
    expect(qwen!.maxTokens).toBe(8192);
    expect(other).not.toHaveProperty("contextWindow");
    expect(other).not.toHaveProperty("contextWindowSource");
  });

  it("keeps the v2 fabrication-removal rules before stamping", async () => {
    const legacy: CrossbarConfigFile = {
      version: 1,
      modelCacheVersion: 2,
      servers: [
        record("llamaswap", [model("swap", { contextWindow: 8192, maxTokens: 4096 })]),
        record("llamacpp", [model("cpp", { contextWindow: 0 })]),
        record("unsloth", [model("un", { contextWindow: 8192, maxTokens: 4096 })]),
      ],
    };
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify(legacy));

    const loaded = await loadConfig({ dir });
    const swap = loaded.servers.find((s) => s.kind === "llamaswap")!.lastKnownModels![0]!;
    const cpp = loaded.servers.find((s) => s.kind === "llamacpp")!.lastKnownModels![0]!;
    const un = loaded.servers.find((s) => s.kind === "unsloth")!.lastKnownModels![0]!;
    // Fabricated 8192s and non-positive values are removed — then nothing left to stamp.
    for (const m of [swap, cpp, un]) {
      expect(m).not.toHaveProperty("contextWindow");
      expect(m).not.toHaveProperty("contextWindowSource");
    }
  });

  it("strips an orphan source (source label without a usable window)", async () => {
    const legacy = {
      version: 1,
      modelCacheVersion: 2,
      servers: [
        record("llamacpp", [
          { ...model("orphan", { contextWindow: 0 }), contextWindowSource: "observed" },
        ]),
      ],
    };
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify(legacy));

    const loaded = await loadConfig({ dir });
    const orphan = loaded.servers[0]!.lastKnownModels![0]!;
    expect(orphan).not.toHaveProperty("contextWindow");
    expect(orphan).not.toHaveProperty("contextWindowSource");
    expect(orphan).not.toHaveProperty("contextWindowAt");
  });

  it("trusts a current-marker (3) cache without re-migrating", async () => {
    const current: CrossbarConfigFile = {
      version: 1,
      modelCacheVersion: 3,
      servers: [
        record("llamaswap", [
          // A legitimate 8192 declared by the proxy — must survive untouched.
          model("swap", { contextWindow: 8192, contextWindowSource: "declared", contextWindowAt: T }),
          model("bare", { contextWindow: 4096 }), // bare value in a v3 file: trusted, not rewritten
        ]),
      ],
    };
    writeFileSync(join(dir, "crossbar.json"), JSON.stringify(current));

    const loaded = await loadConfig({ dir });
    expect(loaded).toEqual(current);
  });

  it("saves marker 3 and round-trips paired windows unchanged", async () => {
    const config: CrossbarConfigFile = {
      version: 1,
      modelCacheVersion: 3,
      servers: [
        record("ollama", [
          { ...model("m", { contextWindow: 234496, contextWindowSource: "observed", contextWindowAt: T }), trainedMax: 262144 },
        ]),
      ],
    };
    await saveConfig(config, { dir });
    const loaded = await loadConfig({ dir });
    expect(loaded.modelCacheVersion).toBe(3);
    const m = loaded.servers[0]!.lastKnownModels![0]!;
    expect(m.contextWindow).toBe(234496);
    expect(m.contextWindowSource).toBe("observed");
    expect(m.contextWindowAt).toBe(T);
    expect(m.trainedMax).toBe(262144);
  });
});
