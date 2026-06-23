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
  buildSettingsItems,
  capabilityActions,
  normalizeManualUrl,
  parseHosts,
  parsePorts,
  probePortDescription,
} from "../../src/ui/onboarding.ts";

import type { DiscoveredServer, HealthState, ModelDescriptor, ServerRecord } from "../../src/core/types.ts";

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
  it("always appends rescan, settings, and '+ Add manually' actions", () => {
    const items = buildDiscoveredItems([], []);
    expect(items).toHaveLength(3);
    expect(items[0]!.value).toBe("__rescan__");
    expect(items[1]!.value).toBe("__settings__");
    expect(items[2]!.value).toBe("__manual__");
    expect(items[2]!.label).toContain("Add");
  });

  it("emits one item per discovered server plus the utility actions", () => {
    const discovered = [
      makeDiscovered({ baseUrl: "http://127.0.0.1:11434", kind: "ollama" }),
      makeDiscovered({ baseUrl: "http://127.0.0.1:1234", kind: "lmstudio" }),
    ];
    const items = buildDiscoveredItems(discovered, []);
    // 2 servers + rescan + settings + manual
    expect(items).toHaveLength(5);
    expect(items[4]!.value).toBe("__manual__");
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

  it("marks a newly discovered, unregistered server as 'Discovered · not added'", () => {
    const discovered = [makeDiscovered()];
    const items = buildDiscoveredItems(discovered, []); // empty registry
    expect(items[0]!.label).not.toContain("(added)");
    expect(items[0]!.description).toContain("Discovered");
    expect(items[0]!.description).toContain("not added");
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

  it("uses the backend's human-readable display name", () => {
    const discovered = [makeDiscovered({ kind: "lmstudio" })];
    const items = buildDiscoveredItems(discovered, []);
    expect(items[0]!.label).toMatch(/^LM Studio/);
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
    // offline-registered entry + utility actions
    expect(items).toHaveLength(4);
    expect(items[0]!.value).toBe("http://127.0.0.1:1234");
    expect(items[0]!.label).toContain("(added)");
    // No health supplied → neutral, no reachability claim.
    expect(items[0]!.description).toBe("Registered · not in this scan");
    expect(items[1]!.value).toBe("__rescan__");
    expect(items[2]!.value).toBe("__settings__");
    expect(items[3]!.value).toBe("__manual__");
  });

  it("does not duplicate a registered server that is also discovered", () => {
    const discovered = [makeDiscovered()];
    const existing = [makeRecord()]; // same id as the discovered server
    const items = buildDiscoveredItems(discovered, existing);
    // 1 discovered + utility actions — NOT an extra offline row
    expect(items).toHaveLength(4);
    expect(items[0]!.label).toContain("(added)");
    expect(items[3]!.value).toBe("__manual__");
  });

  it("keeps disabled registered servers visible so they can be re-enabled", () => {
    const disabled = makeRecord({
      id: "crossbar-vllm-127-0-0-1-8000",
      kind: "vllm",
      baseUrl: "http://127.0.0.1:8000",
      enabled: false,
    });
    const items = buildDiscoveredItems([], [disabled]);
    expect(items).toHaveLength(4);
    expect(items[0]!.value).toBe(disabled.baseUrl);
    expect(items[0]!.label).toContain("(disabled)");
    expect(items[0]!.description).toContain("select to manage");
    expect(items[3]!.value).toBe("__manual__");
  });

  it("marks a reachable disabled server as disabled rather than added", () => {
    const disabled = makeRecord({ enabled: false });
    const items = buildDiscoveredItems([makeDiscovered()], [disabled]);
    expect(items[0]!.label).toContain("(disabled)");
    expect(items[0]!.description).toContain("server is reachable");
  });
});

// ─── not-in-scan health labels ─────────────────────────────────────────────────

describe("buildDiscoveredItems — not-in-scan health labels", () => {
  const offline = makeRecord({
    id: "crossbar-lmstudio-127-0-0-1-1234",
    kind: "lmstudio",
    baseUrl: "http://127.0.0.1:1234",
    label: "LM Studio (127.0.0.1:1234)",
  });

  const describeFor = (health: HealthState | undefined): string | undefined =>
    buildDiscoveredItems([], [offline], () => health)[0]!.description;

  it("reports a polled healthy server as healthy, not 'not reachable'", () => {
    expect(describeFor("healthy")).toBe("Registered · ✓ healthy");
  });

  it("only says 'not reachable' when health was actually polled as unreachable", () => {
    expect(describeFor("unreachable")).toBe("Registered · ✗ not reachable");
  });

  it("surfaces auth and degraded states distinctly", () => {
    expect(describeFor("unauthorized")).toBe("Registered · auth required");
    expect(describeFor("degraded")).toBe("Registered · degraded");
    expect(describeFor("loading")).toBe("Registered · loading");
  });

  it("makes no reachability claim when the server has never been polled", () => {
    expect(describeFor(undefined)).toBe("Registered · not in this scan");
    // and the same when no health lookup is provided at all
    expect(buildDiscoveredItems([], [offline])[0]!.description).toBe("Registered · not in this scan");
  });
});

// ─── Discovery settings helpers ───────────────────────────────────────────────

describe("parsePorts", () => {
  it("parses a comma/space-separated list into sorted unique ports", () => {
    expect(parsePorts("11434, 8080  1234")).toEqual([1234, 8080, 11434]);
  });
  it("drops out-of-range and non-numeric tokens", () => {
    expect(parsePorts("80, 0, 70000, abc, 443")).toEqual([80, 443]);
  });
  it("de-duplicates", () => {
    expect(parsePorts("8080, 8080, 8080")).toEqual([8080]);
  });
  it("returns an empty array for blank input (use defaults)", () => {
    expect(parsePorts("   ")).toEqual([]);
    expect(parsePorts("")).toEqual([]);
  });
});

describe("parseHosts", () => {
  it("splits, trims, and de-duplicates hosts", () => {
    expect(parseHosts(" 192.168.1.50 , nas.local,192.168.1.50 ")).toEqual([
      "192.168.1.50",
      "nas.local",
    ]);
  });
  it("returns an empty array for blank input", () => {
    expect(parseHosts("  ")).toEqual([]);
  });
});

describe("buildSettingsItems", () => {
  it("reflects defaults when no settings are configured", () => {
    const items = buildSettingsItems({});
    expect(items.map((i) => i.value)).toEqual([
      "toggle-autoreg",
      "toggle-lan",
      "edit-hosts",
      "edit-ports",
      "back",
    ]);
    expect(items[0]!.label).toContain("ON"); // localhost auto-register defaults on
    expect(items[1]!.label).toContain("OFF"); // LAN discovery defaults off
    expect(items[2]!.label).toContain("auto"); // blank hosts = auto-scan local subnet
    expect(items[3]!.label).toContain("defaults");
  });
  it("shows the LAN/hosts/ports values when set", () => {
    const items = buildSettingsItems({
      lanDiscovery: true,
      lanHosts: ["192.168.1.50"],
      probePorts: [11434, 8080],
    });
    expect(items[1]!.label).toContain("ON");
    expect(items[2]!.label).toContain("192.168.1.50");
    expect(items[3]!.label).toContain("11434");
    expect(items[3]!.label).toContain("8080");
  });
  it("shows auto-register OFF when disabled", () => {
    const items = buildSettingsItems({ autoRegisterLocalhost: false });
    expect(items[0]!.label).toBe("Auto-register localhost: OFF");
  });
  it("omits the dismissed-servers row when nothing is dismissed", () => {
    const items = buildSettingsItems({});
    expect(items.map((i) => i.value)).not.toContain("edit-dismissed");
  });
  it("shows a dismissed-servers row with a count when present", () => {
    const items = buildSettingsItems({ dismissed: ["http://127.0.0.1:11434"] });
    const row = items.find((i) => i.value === "edit-dismissed");
    expect(row?.label).toBe("Dismissed servers: 1");
  });
});

describe("probePortDescription", () => {
  it("returns friendly names for known default ports", () => {
    expect(probePortDescription(11434)).toContain("Ollama");
    expect(probePortDescription(1234)).toContain("LM Studio");
    expect(probePortDescription(8080)).toContain("llama.cpp");
    expect(probePortDescription(8000)).toContain("vLLM");
    expect(probePortDescription(5000)).toContain("TabbyAPI");
    expect(probePortDescription(5001)).toContain("KoboldCpp");
    expect(probePortDescription(1337)).toContain("Jan");
  });
  it("appends the remove hint for all ports", () => {
    expect(probePortDescription(11434)).toContain("select to remove");
    expect(probePortDescription(9000)).toContain("select to remove");
  });
  it('labels unknown ports as "custom"', () => {
    expect(probePortDescription(4891)).toContain("custom");
  });
});

// ─── buildManageItems ─────────────────────────────────────────────────────────

describe("buildManageItems", () => {
  it("offers 'use' first, then every capability action plus Disable, Remove, and Back", () => {
    const values = buildManageItems(ollamaAdapter, true).map((i) => i.value);
    expect(values[0]).toBe("use");
    expect(values).toEqual(
      expect.arrayContaining(["use", "switch", "load", "unload", "introspect", "disable", "remove", "back"]),
    );
  });

  it("offers 'Use a model in Pi' even for a capability-less backend", () => {
    for (const adapter of [vllmAdapter, openaiAdapter, anthropicAdapter, genericAdapter]) {
      const values = buildManageItems(adapter, true).map((i) => i.value);
      // No switch/load/unload/introspect, but you can still point Pi at a model.
      expect(values).toEqual(["use", "disable", "remove", "back"]);
    }
  });

  it("shows Enable instead of Disable when the server is disabled", () => {
    const values = buildManageItems(vllmAdapter, false).map((i) => i.value);
    expect(values).toEqual(["enable", "remove", "back"]);
    expect(values).not.toContain("disable");
  });

  it("hides operational actions while a capable server is disabled", () => {
    const values = buildManageItems(ollamaAdapter, false).map((i) => i.value);
    expect(values).toEqual(["enable", "remove", "back"]);
  });

  it("puts Back last and Remove immediately before it", () => {
    const items = buildManageItems(ollamaAdapter, true);
    expect(items.at(-2)!.value).toBe("remove");
    expect(items.at(-1)!.value).toBe("back");
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
