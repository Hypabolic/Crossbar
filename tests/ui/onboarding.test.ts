/**
 * Unit tests for the pure helpers in src/ui/onboarding.ts.
 *
 * NO overlay rendering attempted — these tests cover only the four pure helpers:
 *   - buildDiscoveredItems
 *   - buildModelItems
 *   - capabilityActions
 *   - normalizeManualUrl
 *
 * Capability-driven hiding is verified with REAL adapter singletons imported from
 * src/adapters/, so the test is a live check that the adapters honestly declare
 * (or don't declare) the relevant capabilities.
 *
 * Hard rules:
 *   - No network I/O (pure functions only)
 *   - No src/core/, src/adapters/ modifications
 *   - Uses vitest only
 */

import { describe, it, expect } from "vitest";

import {
  buildDiscoveredItems,
  buildManageItems,
  buildModelItems,
  capabilityActions,
  normalizeManualUrl,
} from "../../src/ui/onboarding.ts";

import type { DiscoveredServer, ModelDescriptor, ServerRecord } from "../../src/core/types.ts";

// Real adapter singletons for capability-driven tests
import { ollamaAdapter } from "../../src/adapters/ollama.ts";
import { lmstudioAdapter } from "../../src/adapters/lmstudio.ts";
import { vllmAdapter } from "../../src/adapters/vllm.ts";
import { openaiAdapter } from "../../src/adapters/openai.ts";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import { genericAdapter } from "../../src/adapters/generic.ts";
import { llamaswapAdapter } from "../../src/adapters/llamaswap.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDiscovered(overrides: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    auth: "none",
    label: "Ollama (127.0.0.1:11434)",
    confidence: 0.95,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: "crossbar-ollama-127-0-0-1-11434",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    label: "Ollama (127.0.0.1:11434)",
    auth: "none",
    enabled: true,
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: "llama3.1",
    name: "llama3.1",
    contextWindow: 32768,
    maxTokens: 4096,
    input: ["text"],
    reasoning: false,
    tools: false,
    embeddings: false,
    ...overrides,
  };
}

// ─── buildDiscoveredItems ────────────────────────────────────────────────────

describe("buildDiscoveredItems", () => {
  it("always appends a '+ Add manually' sentinel at the end", () => {
    const items = buildDiscoveredItems([], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe("__manual__");
    expect(items[0]!.label).toContain("Add");
  });

  it("emits one item per discovered server plus the manual sentinel", () => {
    const discovered = [
      makeDiscovered({ baseUrl: "http://127.0.0.1:11434", kind: "ollama" }),
      makeDiscovered({ baseUrl: "http://127.0.0.1:1234", kind: "lmstudio" }),
    ];
    const items = buildDiscoveredItems(discovered, []);
    // 2 servers + 1 manual sentinel
    expect(items).toHaveLength(3);
    expect(items[2]!.value).toBe("__manual__");
  });

  it("uses the server baseUrl as the item value", () => {
    const discovered = [makeDiscovered({ baseUrl: "http://127.0.0.1:11434" })];
    const items = buildDiscoveredItems(discovered, []);
    expect(items[0]!.value).toBe("http://127.0.0.1:11434");
  });

  it("marks a server as '(added)' when its id already exists in the registry", () => {
    const discovered = [makeDiscovered()];
    const existing = [makeRecord()]; // same id: crossbar-ollama-127-0-0-1-11434
    const items = buildDiscoveredItems(discovered, existing);
    expect(items[0]!.label).toContain("(added)");
    expect(items[0]!.description).toContain("Already registered");
  });

  it("does NOT mark a server as added when it is new", () => {
    const discovered = [makeDiscovered()];
    const items = buildDiscoveredItems(discovered, []); // empty registry
    expect(items[0]!.label).not.toContain("(added)");
    expect(items[0]!.description).toContain("healthy");
  });

  it("includes version in the description when present", () => {
    const discovered = [makeDiscovered({ version: "0.5.1" })];
    const items = buildDiscoveredItems(discovered, []);
    expect(items[0]!.description).toContain("v0.5.1");
  });

  it("includes auth mode in the description", () => {
    const discovered = [makeDiscovered({ auth: "apiKey" })];
    const items = buildDiscoveredItems(discovered, []);
    expect(items[0]!.description).toContain("apiKey");
  });

  it("handles an https server with a custom port correctly", () => {
    const discovered = [makeDiscovered({ baseUrl: "https://192.168.1.10:8443" })];
    const items = buildDiscoveredItems(discovered, []);
    // Should extract host:port correctly
    expect(items[0]!.label).toContain("192.168.1.10:8443");
  });

  it("capitalises the kind in the label", () => {
    const discovered = [makeDiscovered({ kind: "lmstudio" })];
    const items = buildDiscoveredItems(discovered, []);
    // Label starts with the capitalized kind
    expect(items[0]!.label).toMatch(/^Lmstudio/);
  });

  it("appends registered servers that were not discovered this scan", () => {
    // A registered server with a baseUrl not present in `discovered` should still
    // appear (so it can be managed/removed even while offline).
    const offline = makeRecord({
      id: "crossbar-lmstudio-127-0-0-1-1234",
      kind: "lmstudio",
      baseUrl: "http://127.0.0.1:1234",
      label: "LM Studio (127.0.0.1:1234)",
    });
    const items = buildDiscoveredItems([], [offline]);
    // offline-registered entry + manual sentinel
    expect(items).toHaveLength(2);
    expect(items[0]!.value).toBe("http://127.0.0.1:1234");
    expect(items[0]!.label).toContain("(added)");
    expect(items[0]!.description).toContain("not currently discovered");
    expect(items[1]!.value).toBe("__manual__");
  });

  it("does not duplicate a registered server that is also discovered", () => {
    const discovered = [makeDiscovered()];
    const existing = [makeRecord()]; // same id as the discovered server
    const items = buildDiscoveredItems(discovered, existing);
    // 1 discovered (marked added) + manual sentinel — NOT an extra offline row
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toContain("(added)");
    expect(items[1]!.value).toBe("__manual__");
  });

  it("skips disabled registered servers in the offline-append pass", () => {
    const disabled = makeRecord({
      id: "crossbar-vllm-127-0-0-1-8000",
      kind: "vllm",
      baseUrl: "http://127.0.0.1:8000",
      enabled: false,
    });
    const items = buildDiscoveredItems([], [disabled]);
    // Only the manual sentinel — the disabled server is not appended.
    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe("__manual__");
  });
});

// ─── buildManageItems ─────────────────────────────────────────────────────────

describe("buildManageItems", () => {
  it("offers every capability action plus Disable + Remove for an enabled full-capability backend", () => {
    const values = buildManageItems(ollamaAdapter, true).map((i) => i.value);
    expect(values).toEqual(
      expect.arrayContaining(["switch", "load", "unload", "introspect", "disable", "remove"]),
    );
  });

  it("offers Disable/Remove (only) for an enabled capability-less backend", () => {
    for (const adapter of [vllmAdapter, openaiAdapter, anthropicAdapter, genericAdapter]) {
      const values = buildManageItems(adapter, true).map((i) => i.value);
      expect(values).toEqual(["disable", "remove"]);
    }
  });

  it("shows Enable instead of Disable when the server is disabled", () => {
    const values = buildManageItems(vllmAdapter, false).map((i) => i.value);
    expect(values).toEqual(["enable", "remove"]);
    expect(values).not.toContain("disable");
  });

  it("puts Remove last in the list", () => {
    const items = buildManageItems(ollamaAdapter, true);
    expect(items[items.length - 1]!.value).toBe("remove");
  });

  it("gives every item a non-empty label and value", () => {
    for (const item of buildManageItems(lmstudioAdapter, true)) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.value.length).toBeGreaterThan(0);
    }
  });
});

// ─── buildModelItems ─────────────────────────────────────────────────────────

describe("buildModelItems", () => {
  it("returns one item per model", () => {
    const models = [makeModel({ id: "a" }), makeModel({ id: "b" }), makeModel({ id: "c" })];
    expect(buildModelItems(models)).toHaveLength(3);
  });

  it("uses model id as the item value", () => {
    const items = buildModelItems([makeModel({ id: "llama3.1:8b" })]);
    expect(items[0]!.value).toBe("llama3.1:8b");
  });

  it("uses model name as the label when available", () => {
    const items = buildModelItems([makeModel({ id: "llama3.1", name: "Llama 3.1" })]);
    expect(items[0]!.label).toBe("Llama 3.1");
  });

  it("falls back to id when name is empty", () => {
    const items = buildModelItems([makeModel({ id: "llama3.1", name: "" })]);
    expect(items[0]!.label).toBe("llama3.1");
  });

  it("includes context window in description", () => {
    // Math.round(32768/1000) = 33
    const items = buildModelItems([makeModel({ contextWindow: 32768 })]);
    expect(items[0]!.description).toContain("33k ctx");
  });

  it("formats small context windows without k suffix", () => {
    const items = buildModelItems([makeModel({ contextWindow: 512 })]);
    expect(items[0]!.description).toContain("512 ctx");
  });

  it("includes reasoning badge when set", () => {
    const items = buildModelItems([makeModel({ reasoning: true })]);
    expect(items[0]!.description).toContain("reasoning");
  });

  it("includes tools badge when set", () => {
    const items = buildModelItems([makeModel({ tools: true })]);
    expect(items[0]!.description).toContain("tools");
  });

  it("includes vision badge when image is in input modalities", () => {
    const items = buildModelItems([makeModel({ input: ["text", "image"] })]);
    expect(items[0]!.description).toContain("vision");
  });

  it("includes embeddings badge when set", () => {
    const items = buildModelItems([makeModel({ embeddings: true })]);
    expect(items[0]!.description).toContain("embeddings");
  });

  it("produces no description when context window is absent and no caps", () => {
    // Omit contextWindow entirely (exactOptionalPropertyTypes forbids passing undefined)
    const base = makeModel({ reasoning: false, tools: false, embeddings: false, input: ["text"] });
    const { contextWindow: _omit, ...withoutCtx } = base;
    const m: ModelDescriptor = withoutCtx;
    const items = buildModelItems([m]);
    expect(items[0]!.description).toBeUndefined();
  });

  it("handles an empty model list", () => {
    expect(buildModelItems([])).toHaveLength(0);
  });
});

// ─── capabilityActions ────────────────────────────────────────────────────────

describe("capabilityActions", () => {
  // ── Ollama: full set (Switch + LoadUnload + IntrospectLoaded) ───────────────
  describe("ollama adapter (full capabilities)", () => {
    const actions = capabilityActions(ollamaAdapter);
    const values = actions.map((a) => a.value);

    it("includes switch", () => {
      expect(values).toContain("switch");
    });
    it("includes load", () => {
      expect(values).toContain("load");
    });
    it("includes unload", () => {
      expect(values).toContain("unload");
    });
    it("includes introspect", () => {
      expect(values).toContain("introspect");
    });
  });

  // ── LM Studio: Switch + LoadUnload + IntrospectLoaded ──────────────────────
  describe("lmstudio adapter (Switch + LoadUnload + IntrospectLoaded)", () => {
    const actions = capabilityActions(lmstudioAdapter);
    const values = actions.map((a) => a.value);

    it("includes switch", () => {
      expect(values).toContain("switch");
    });
    it("includes load", () => {
      expect(values).toContain("load");
    });
    it("includes unload", () => {
      expect(values).toContain("unload");
    });
    it("includes introspect", () => {
      expect(values).toContain("introspect");
    });
  });

  // ── vLLM: no Switch, no LoadUnload, no IntrospectLoaded ────────────────────
  describe("vllm adapter (no switch / load / unload / introspect)", () => {
    const actions = capabilityActions(vllmAdapter);
    const values = actions.map((a) => a.value);

    it("does not include switch", () => {
      expect(values).not.toContain("switch");
    });
    it("does not include load", () => {
      expect(values).not.toContain("load");
    });
    it("does not include unload", () => {
      expect(values).not.toContain("unload");
    });
    it("does not include introspect", () => {
      expect(values).not.toContain("introspect");
    });
    it("returns empty array", () => {
      expect(actions).toHaveLength(0);
    });
  });

  // ── OpenAI (cloud): no capabilities of interest ────────────────────────────
  describe("openai adapter (cloud — no local capabilities)", () => {
    const actions = capabilityActions(openaiAdapter);

    it("returns empty array", () => {
      expect(actions).toHaveLength(0);
    });
  });

  // ── Anthropic (cloud): no capabilities of interest ─────────────────────────
  describe("anthropic adapter (cloud — no local capabilities)", () => {
    const actions = capabilityActions(anthropicAdapter);

    it("returns empty array", () => {
      expect(actions).toHaveLength(0);
    });
  });

  // ── Generic OpenAI-compat: no Switch/LoadUnload/IntrospectLoaded ───────────
  describe("generic adapter (no switch / load / unload / introspect)", () => {
    const actions = capabilityActions(genericAdapter);
    const values = actions.map((a) => a.value);

    it("does not include switch", () => {
      expect(values).not.toContain("switch");
    });
    it("does not include load", () => {
      expect(values).not.toContain("load");
    });
    it("does not include unload", () => {
      expect(values).not.toContain("unload");
    });
  });

  // ── llama-swap: has Switch (proxy swap) ────────────────────────────────────
  describe("llamaswap adapter (has SwitchModel)", () => {
    const actions = capabilityActions(llamaswapAdapter);
    const values = actions.map((a) => a.value);

    it("includes switch", () => {
      expect(values).toContain("switch");
    });
  });

  // ── Each action has both label and value ───────────────────────────────────
  it("each action has a non-empty label and value", () => {
    const actions = capabilityActions(ollamaAdapter);
    for (const action of actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.value.length).toBeGreaterThan(0);
    }
  });
});

// ─── normalizeManualUrl ───────────────────────────────────────────────────────

describe("normalizeManualUrl", () => {
  // Already-valid URLs
  it("accepts a fully-qualified http URL unchanged (origin only)", () => {
    expect(normalizeManualUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });

  it("accepts a fully-qualified https URL (standard port is elided from origin)", () => {
    // URL.origin drops the default port (443 for https), so origin = "https://example.com"
    expect(normalizeManualUrl("https://example.com:443")).toBe("https://example.com");
  });

  // Scheme injection
  it("prepends http:// to a bare host:port", () => {
    expect(normalizeManualUrl("localhost:11434")).toBe("http://localhost:11434");
  });

  it("prepends http:// to an IP:port without scheme", () => {
    expect(normalizeManualUrl("192.168.1.5:8080")).toBe("http://192.168.1.5:8080");
  });

  // Trailing slashes stripped
  it("strips a trailing slash from a URL with path", () => {
    expect(normalizeManualUrl("http://localhost:11434/")).toBe("http://localhost:11434");
  });

  it("strips paths beyond the origin", () => {
    // Only the origin is retained; /v1 is stripped
    expect(normalizeManualUrl("http://localhost:11434/v1")).toBe("http://localhost:11434");
  });

  // Whitespace trimming
  it("trims leading and trailing whitespace", () => {
    expect(normalizeManualUrl("  localhost:11434  ")).toBe("http://localhost:11434");
  });

  // Port 80 handling — browsers omit it from origin
  it("handles localhost without explicit port", () => {
    const result = normalizeManualUrl("localhost");
    // Should parse as http://localhost (port 80 omitted from origin)
    expect(result).toBe("http://localhost");
  });

  // Standard ports
  it("preserves non-standard ports", () => {
    expect(normalizeManualUrl("http://my-server:8000")).toBe("http://my-server:8000");
  });

  it("preserves LM Studio default port", () => {
    expect(normalizeManualUrl("localhost:1234")).toBe("http://localhost:1234");
  });

  it("preserves vLLM default port", () => {
    expect(normalizeManualUrl("localhost:8000")).toBe("http://localhost:8000");
  });

  // Query strings / hashes are stripped (only origin retained)
  it("strips query string", () => {
    expect(normalizeManualUrl("http://localhost:11434?foo=bar")).toBe("http://localhost:11434");
  });

  // Error cases
  it("throws on an input that cannot form a valid URL", () => {
    expect(() => normalizeManualUrl("not a url !!!")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => normalizeManualUrl("")).toThrow();
  });
});
