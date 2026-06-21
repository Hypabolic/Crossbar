/**
 * Reference (fake) BackendAdapter — Wave A self-test.
 *
 * Implements the FULL BackendAdapter contract honestly, labelled kind
 * "openai-generic" with a display name of "Reference".  Its fixture exercises
 * every conformance case so the harness is green before any real adapter is
 * written.
 *
 * This module also exports `referenceFixture` (the `AdapterFixture`) that
 * contract.test.ts imports.
 */

import { Capability } from "../../src/core/capability.ts";
import type { BackendAdapter, PiApiType } from "../../src/core/backend-adapter.ts";
import type {
  DiscoveredServer,
  HealthStatus,
  LoadAction,
  LoadedState,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ProbeResult,
  ServerCredential,
} from "../../src/core/types.ts";
import type { AdapterFixture } from "./fixtures.ts";
import { REFUSED, UNAUTHORIZED, sequence, auth401 } from "./fake-probe.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://127.0.0.1:19999";

/** A well-known model set returned by the reference fixture. */
const REFERENCE_MODELS: ModelDescriptor[] = [
  {
    id: "ref-chat-a",
    name: "Reference Chat A",
    contextWindow: 8192,
    maxTokens: 4096,
    input: ["text"],
    reasoning: false,
    tools: true,
    embeddings: false,
  },
  {
    id: "ref-chat-b",
    name: "Reference Chat B",
    contextWindow: 32768,
    maxTokens: 8192,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    embeddings: false,
  },
  {
    id: "ref-embed-1",
    name: "Reference Embeddings 1",
    contextWindow: 512,
    maxTokens: 512,
    input: ["text"],
    embeddings: true, // must be filtered out of chat list
  },
];

// ---------------------------------------------------------------------------
// ReferenceAdapter
// ---------------------------------------------------------------------------

/**
 * A minimal but *fully honest* BackendAdapter that declares every optional
 * capability and implements every optional method.  Used only for self-testing
 * the harness.
 */
class ReferenceAdapter implements BackendAdapter {
  readonly kind = "openai-generic" as const;
  readonly displayName = "Reference (fake)";
  readonly defaultPorts: readonly number[] = [19999];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.IntrospectLoaded,
    Capability.SwitchModel,
    Capability.LoadUnload,
    Capability.Health,
    Capability.PerModelCaps,
    Capability.Streaming,
  ]);

  // --- fingerprint --------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    const r = await probe("/ref/ping");
    if (!r.ok) return null;
    const body = r.json as { service?: string } | undefined;
    if (body?.service !== "reference") return null;
    return {
      kind: "openai-generic",
      baseUrl,
      auth: "none",
      label: `Reference (${baseUrl})`,
      confidence: 0.95,
    };
  }

  // --- health -------------------------------------------------------------

  async health(
    server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<HealthStatus> {
    const r = await probe("/ref/health");
    if (!r.ok) {
      if (r.status === 401) return { state: "unauthorized" };
      if (r.status === 0) return { state: "unreachable" };
      return { state: "degraded" };
    }
    const status: HealthStatus = { state: "healthy" };
    if (r.latencyMs !== undefined) status.latencyMs = r.latencyMs;
    return status;
  }

  // --- listModels ---------------------------------------------------------

  async listModels(
    _server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }
    const r = await probe("/v1/models", { headers });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`listModels failed: status ${r.status}`);
    }
    const body = r.json as { data?: Array<{ id: string }> } | undefined;
    if (!body?.data) return [];
    // In a real adapter this would map API data → ModelDescriptor.
    // Here we just return the pre-built set, identified by comparing ids.
    const ids = new Set(body.data.map((m) => m.id));
    return REFERENCE_MODELS.filter((m) => ids.has(m.id));
  }

  // --- introspectLoaded ---------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const r = await probe("/ref/loaded");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }
    const body = r.json as { loaded?: string[] } | undefined;
    return {
      loadedModelIds: body?.loaded ?? [],
      source: "introspection",
    };
  }

  // --- switchModel --------------------------------------------------------

  async switchModel(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    modelId: string,
    probe: Probe,
  ): Promise<void> {
    // Step 1: request the switch
    const r1 = await probe("/ref/switch", {
      method: "POST",
      body: JSON.stringify({ model: modelId }),
      headers: { "content-type": "application/json" },
    });
    if (!r1.ok) {
      if (r1.status === 0) throw new Error("server unreachable during switch");
      if (r1.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`switchModel failed: status ${r1.status}`);
    }
    // Step 2: confirm the switch (this is where server-down-mid-switch manifests)
    const r2 = await probe("/ref/loaded");
    if (!r2.ok) {
      if (r2.status === 0) throw new Error("server went down after switch request");
      throw new Error(`switchModel confirmation failed: status ${r2.status}`);
    }
    const body = r2.json as { loaded?: string[] } | undefined;
    if (!body?.loaded?.includes(modelId)) {
      throw new Error(`model-not-loaded: ${modelId} not found after switch`);
    }
  }

  // --- loadUnload ---------------------------------------------------------

  async loadUnload(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    modelId: string,
    action: LoadAction,
    probe: Probe,
  ): Promise<void> {
    const path = action === "load" ? "/ref/load" : "/ref/unload";
    const r = await probe(path, {
      method: "POST",
      body: JSON.stringify({ model: modelId }),
      headers: { "content-type": "application/json" },
    });
    if (!r.ok) {
      if (r.status === 0) throw new Error(`server unreachable during ${action}`);
      if (r.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`loadUnload(${action}) failed: status ${r.status}`);
    }
  }

  // --- toPiModel ----------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 4096,
      maxTokens: model.maxTokens ?? 2048,
    };
  }

  // --- inferenceBaseUrl ---------------------------------------------------

  inferenceBaseUrl(server: DiscoveredServer): string {
    return `${server.baseUrl}/v1`;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const referenceAdapter: BackendAdapter = new ReferenceAdapter();

// ---------------------------------------------------------------------------
// Fixture routes
// ---------------------------------------------------------------------------

/** The normal /v1/models response (all models, including the embeddings model). */
const MODELS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      { id: "ref-chat-a" },
      { id: "ref-chat-b" },
      { id: "ref-embed-1" },
    ],
  },
};

/** The fingerprint ping response. */
const PING_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { service: "reference" },
};

/** Introspect: ref-chat-a is loaded. */
const LOADED_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { loaded: ["ref-chat-a"] },
};

/** Switch acknowledged. */
const SWITCH_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { ok: true },
};

/** After switching to ref-chat-b: loaded list reflects it. */
const LOADED_AFTER_SWITCH: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { loaded: ["ref-chat-b"] },
};

/** Load/unload acknowledged. */
const LOAD_UNLOAD_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: {},
  json: { ok: true },
};

/** Health OK. */
const HEALTH_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: {},
  json: { status: "ok" },
  latencyMs: 4,
};

// Routes for the "negative" fingerprint test: these look like a different
// backend entirely (Ollama-style root text response, no /ref/ping).
const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/": {
    status: 200,
    ok: true,
    headers: { "content-type": "text/plain" },
    text: "Ollama is running",
  },
};

// Routes for auth failure (every path returns 401).
const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/v1/models": UNAUTHORIZED,
  "/ref/loaded": UNAUTHORIZED,
};

// Routes for server-down-mid-switch: switch POST succeeds, but the
// confirmation probe (GET /ref/loaded) returns status 0.
const SERVER_DOWN_MID_SWITCH_ROUTES: Record<
  string,
  ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)
> = {
  "/ref/ping": PING_RESPONSE,
  "POST /ref/switch": SWITCH_OK,
  "/ref/loaded": sequence(
    // first call (initial introspect for confirmation): server goes down
    REFUSED,
  ),
};

// ---------------------------------------------------------------------------
// referenceFixture — the AdapterFixture for Wave A self-testing
// ---------------------------------------------------------------------------

export const referenceFixture: AdapterFixture = {
  name: "Reference (fake)",
  adapter: referenceAdapter,
  cred: { mode: "none" },

  // The server the fixture fingerprints to (used in capability calls).
  server: {
    kind: "openai-generic",
    baseUrl: BASE_URL,
    auth: "none",
    label: "Reference (127.0.0.1:19999)",
    confidence: 0.95,
  },

  // --- positive route set ---------------------------------------------------
  routes: {
    "/ref/ping": PING_RESPONSE,
    "/ref/health": HEALTH_OK,
    "/v1/models": MODELS_RESPONSE,
    "/ref/loaded": LOADED_RESPONSE,
    // switchModel makes a POST then re-reads /ref/loaded
    "POST /ref/switch": SWITCH_OK,
    // After switch the confirmation probe should see ref-chat-b loaded.
    // We use the default /ref/loaded which already shows ref-chat-a; the
    // success-path switch test uses its own probe to sequence this.
    "/ref/load": LOAD_UNLOAD_OK,
    "/ref/unload": LOAD_UNLOAD_OK,
  },

  // --- negative fingerprint -------------------------------------------------
  negativeRoutes: NEGATIVE_ROUTES,

  // --- auth-failure routes --------------------------------------------------
  authFailureRoutes: AUTH_FAILURE_ROUTES,

  // --- server-down-mid-switch routes ----------------------------------------
  serverDownRoutes: SERVER_DOWN_MID_SWITCH_ROUTES,

  // --- switch-success overlay (confirmation probe shows ref-chat-b loaded) ---
  switchSuccessRoutes: buildSwitchSuccessRoutes(),

  // --- model ids for edge-case tests ----------------------------------------
  switchModelId: "ref-chat-b",
  loadModelId: "ref-chat-a",
  missingModelId: "no-such-model",

  expect: {
    fingerprint: {
      kind: "openai-generic",
      confidenceMin: 0.9,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: ["ref-chat-a", "ref-chat-b"],
      excludedIds: ["ref-embed-1"],
      minCount: 2,
    },
    loadedState: {
      anyOf: ["ref-chat-a"],
      source: "introspection",
    },
    inferenceBaseUrlPrefix: "http://",
  },
};

// ---------------------------------------------------------------------------
// Switch-success probe (needs sequenced /ref/loaded for confirmation)
// ---------------------------------------------------------------------------

/**
 * Returns a route map for a successful switchModel test where we switch to
 * `ref-chat-b` and the confirmation probe returns it as loaded.
 */
export function buildSwitchSuccessRoutes(): Record<
  string,
  ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)
> {
  return {
    "/ref/ping": PING_RESPONSE,
    "POST /ref/switch": SWITCH_OK,
    // confirmation probe: ref-chat-b is now loaded
    "/ref/loaded": LOADED_AFTER_SWITCH,
  };
}
