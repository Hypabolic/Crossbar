/**
 * oMLX backend adapter for Crossbar.
 *
 * oMLX is a local LLM inference server optimized for Apple Silicon that exposes
 * OpenAI-compatible and Anthropic-compatible API endpoints at port 8000.
 *
 * Implements the BackendAdapter contract for oMLX's OpenAI-compatible HTTP API:
 *   - Fingerprint: GET /v1/models with owned_by:"omlx" and max_model_len
 *   - List models: GET /v1/models → ModelCard[] {id, max_model_len, owned_by, object, created}
 *   - Health: GET /health (empty 200 ⇒ healthy; 503 ⇒ loading; no auth required)
 *   - IntrospectLoaded: GET /v1/models/status → loaded model residency
 *   - LoadUnload: POST /v1/models/{id}/load or /{id}/unload
 *   - SwitchModel: POST /v1/models/{id}/load → confirm via GET /v1/models/status
 *   - Inference base URL: server.baseUrl + "/v1"
 *
 * Uses ONLY the injected Probe — never calls fetch directly.
 */

import { Capability } from "../core/capability.ts";
import type { BackendAdapter, PiApiType } from "../core/backend-adapter.ts";
import type {
  DiscoveredServer,
  HealthStatus,
  LoadAction,
  LoadedState,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ServerCredential,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shapes matching oMLX's API responses
// ---------------------------------------------------------------------------

interface OmlxModelCard {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  max_model_len?: number;
  loaded?: boolean;
  /** Some oMLX builds expose the human alias here instead of (or in addition to) the physical id. */
  model_alias?: string;
}

interface OmlxModelsResponse {
  object?: string;
  data?: OmlxModelCard[];
}

interface OmlxLoadedModelInfo {
  id: string;
  /** Alias used by listModels / UI; load/unload often want the physical `id`. */
  model_alias?: string;
  model_path?: string;
  loaded?: boolean;
  is_loading?: boolean;
  loading_started_at?: number | null;
  estimated_size?: number;
  actual_size?: number;
  pinned?: boolean;
  engine_type?: string;
  model_type?: string;
  config_model_type?: string;
  is_helper?: boolean;
  thinking_default?: boolean;
  preserve_thinking_default?: boolean;
  source_type?: string;
  source_repo_id?: string | null;
  last_access?: number | null;
  max_context_window?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

interface OmlxModelsStatusResponse {
  object?: string;
  data?: OmlxLoadedModelInfo[];
  /** Some oMLX builds nest the status list under `models` instead of OpenAI `data`. */
  models?: OmlxLoadedModelInfo[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 4096;

/** Id / type tokens that indicate non-chat (embedding, reranker, helper) models. */
const NON_CHAT_ID_RE =
  /(^|[/:._-])(embed|embedding|bge|gte|e5|reranker|rerank)([/:._-]|$)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(cred: ServerCredential): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cred.mode === "apiKey" && cred.apiKey) {
    headers["Authorization"] = `Bearer ${cred.apiKey}`;
  }
  return headers;
}

/** Prefer `models`, fall back to OpenAI-style `data`. */
function statusEntries(body: OmlxModelsStatusResponse | undefined): OmlxLoadedModelInfo[] {
  if (!body) return [];
  if (Array.isArray(body.models)) return body.models;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

/**
 * Build alias ↔ physical id maps from status entries.
 * Keys are lowercased for case-insensitive lookup; values preserve original casing.
 */
function buildAliasMaps(statusData: OmlxLoadedModelInfo[]): {
  /** Any known key (physical id or alias) → preferred physical id for load/unload. */
  toPhysical: Map<string, string>;
  /** Any known key → model_alias when present, else physical id (for list matching). */
  toAlias: Map<string, string>;
  /** Any known key → thinking_default. */
  thinking: Map<string, boolean>;
  /** Any known key → full status row. */
  byKey: Map<string, OmlxLoadedModelInfo>;
} {
  const toPhysical = new Map<string, string>();
  const toAlias = new Map<string, string>();
  const thinking = new Map<string, boolean>();
  const byKey = new Map<string, OmlxLoadedModelInfo>();

  for (const m of statusData) {
    const physical = m.id;
    const alias = typeof m.model_alias === "string" && m.model_alias.length > 0 ? m.model_alias : undefined;
    const keys = [physical, alias].filter((k): k is string => typeof k === "string" && k.length > 0);
    const preferredAlias = alias ?? physical;
    const thinks = m.thinking_default === true;

    for (const k of keys) {
      const lk = k.toLowerCase();
      toPhysical.set(lk, physical);
      toAlias.set(lk, preferredAlias);
      thinking.set(lk, thinks);
      byKey.set(lk, m);
    }
  }

  return { toPhysical, toAlias, thinking, byKey };
}

function isNonChatModel(
  listId: string,
  status: OmlxLoadedModelInfo | undefined,
): boolean {
  const typeBits = [
    status?.model_type,
    status?.engine_type,
    status?.config_model_type,
  ]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();

  if (
    typeBits.includes("embed") ||
    typeBits.includes("rerank") ||
    typeBits.includes("helper") ||
    typeBits === "embedding" ||
    typeBits === "reranker"
  ) {
    return true;
  }

  if (status?.is_helper === true) return true;

  const normalizedId = listId.toLowerCase();
  if (NON_CHAT_ID_RE.test(normalizedId) || normalizedId.includes("nomic-embed")) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// OmlxAdapter
// ---------------------------------------------------------------------------

class OmlxAdapter implements BackendAdapter {
  readonly kind = "omlx" as const;
  readonly displayName = "oMLX";
  readonly defaultPorts: readonly number[] = [8000];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.Health,
    Capability.IntrospectLoaded,
    Capability.SwitchModel,
    Capability.LoadUnload,
    Capability.PerModelCaps,
    Capability.Streaming,
  ]);

  // --- fingerprint ----------------------------------------------------------

  /**
   * Probe GET /v1/models. Returns a DiscoveredServer at HIGH confidence (~0.85) when the
   * response contains at least one model with owned_by:"omlx" and max_model_len.
   *
   * Higher confidence than the generic adapter (0.3) so oMLX servers are claimed by this
   * adapter and not lost to the catch-all generic handler.
   */
  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    const modelsResult = await probe("/v1/models");
    if (modelsResult.status === 0) return null;
    if (!modelsResult.ok) return null;

    const body = modelsResult.json as OmlxModelsResponse | undefined;
    const models = body?.data ?? [];
    const hasOmlxModel = models.some(
      (m) => m.owned_by === "omlx" && typeof m.max_model_len === "number",
    );
    if (!hasOmlxModel) return null;

    return {
      kind: "omlx",
      baseUrl,
      auth: "none",
      label: `oMLX (${baseUrl.replace(/^https?:\/\//, "")})`,
      confidence: 0.85,
    };
  }

  // --- health ---------------------------------------------------------------

  async health(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<HealthStatus> {
    const r = await probe("/health");
    if (r.status === 0) {
      const s: HealthStatus = { state: "unreachable" };
      if (r.error !== undefined) s.detail = r.error;
      return s;
    }
    if (r.status === 401) return { state: "unauthorized" };
    // oMLX (like vLLM) returns 503 while models are loading — not degraded.
    if (r.status === 503) {
      const bodyStatus = (r.json as { status?: string } | undefined)?.status;
      const health: HealthStatus = { state: "loading" };
      if (typeof bodyStatus === "string" && bodyStatus.length > 0) {
        health.detail = bodyStatus;
      } else {
        health.detail = "status 503";
      }
      return health;
    }
    if (!r.ok) return { state: "degraded", detail: `status ${r.status}` };
    const health: HealthStatus = { state: "healthy" };
    if (r.latencyMs !== undefined) health.latencyMs = r.latencyMs;
    return health;
  }

  // --- listModels -----------------------------------------------------------

  async listModels(
    _server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    const headers = authHeaders(cred);

    const r = await probe("/v1/models", { headers });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    const body = r.json as OmlxModelsResponse | undefined;
    const rawModels = body?.data ?? [];

    // Enrich from the status endpoint (thinking, alias↔physical, model_type).
    let maps = buildAliasMaps([]);
    try {
      const statusR = await probe("/v1/models/status", { headers });
      if (statusR.ok) {
        const statusBody = statusR.json as OmlxModelsStatusResponse | undefined;
        maps = buildAliasMaps(statusEntries(statusBody));
      }
    } catch {
      // Status endpoint may not exist or be reachable — fall back gracefully.
    }

    return rawModels.map((m): ModelDescriptor => {
      const listId = m.id;
      const lk = listId.toLowerCase();
      const status = maps.byKey.get(lk);
      // Prefer status model_alias when matching; also accept physical id as list id.
      const thinking =
        maps.thinking.get(lk) ??
        (status?.thinking_default === true);

      const isEmbedding = isNonChatModel(listId, status);

      const desc: ModelDescriptor = {
        id: listId,
        name: listId,
        contextWindow: typeof m.max_model_len === "number" ? m.max_model_len : DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: ["text"],
        reasoning: thinking === true,
        embeddings: isEmbedding,
        raw: m,
      };
      return desc;
    });
  }

  // --- introspectLoaded -----------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const headers = authHeaders(cred);

    const r = await probe("/v1/models/status", { headers });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }

    const body = r.json as OmlxModelsStatusResponse | undefined;
    const statusData = statusEntries(body);

    const loadedModelIds: string[] = [];
    const perModel: Record<string, { vramBytes?: number; expiresAt?: number }> = {};

    for (const m of statusData) {
      if (m.loaded === true) {
        // Prefer alias for display/list consistency when present; keep physical as secondary key space via maps.
        const displayId =
          typeof m.model_alias === "string" && m.model_alias.length > 0 ? m.model_alias : m.id;
        loadedModelIds.push(displayId);
        // Also record physical id when it differs so switch confirmation by either key works upstream.
        if (displayId !== m.id && !loadedModelIds.includes(m.id)) {
          loadedModelIds.push(m.id);
        }
        const info: { vramBytes?: number; expiresAt?: number } = {};
        if (m.actual_size !== undefined) info.vramBytes = m.actual_size;
        perModel[displayId] = info;
        if (displayId !== m.id) {
          perModel[m.id] = info;
        }
      }
    }

    // exactOptionalPropertyTypes: never pass explicit `undefined` for optional props.
    const result: LoadedState = {
      loadedModelIds,
      source: "introspection",
    };
    if (Object.keys(perModel).length > 0) {
      result.perModel = perModel;
    }
    return result;
  }

  // --- switchModel ----------------------------------------------------------

  async switchModel(
    _server: DiscoveredServer,
    cred: ServerCredential,
    modelId: string,
    probe: Probe,
  ): Promise<void> {
    const headers = authHeaders(cred);

    // Resolve alias → physical id when status is available (load endpoints prefer physical/dir ids).
    let loadId = modelId;
    try {
      const statusPre = await probe("/v1/models/status", { headers });
      if (statusPre.ok) {
        const maps = buildAliasMaps(statusEntries(statusPre.json as OmlxModelsStatusResponse | undefined));
        const physical = maps.toPhysical.get(modelId.toLowerCase());
        if (physical) loadId = physical;
      }
    } catch {
      // Proceed with the caller-supplied id.
    }

    // Step 1: trigger load by POSTing to /v1/models/{id}/load
    const r1 = await probe(`/v1/models/${encodeURIComponent(loadId)}/load`, {
      method: "POST",
      headers,
    });
    if (!r1.ok) {
      if (r1.status === 0) throw new Error("server unreachable during switch");
      if (r1.status === 401) throw new Error("401 Unauthorized during switch");
      const errorBody = (r1.json as { error?: { message?: string } })?.error;
      throw new Error(
        `switchModel load failed: ${errorBody?.message ?? `status ${r1.status}`}`,
      );
    }

    // Step 2: confirm via /v1/models/status that the target model is now loaded
    const r2 = await probe("/v1/models/status", { headers });
    if (!r2.ok) {
      if (r2.status === 0) throw new Error("server went down after switch request");
      if (r2.status === 401) throw new Error("401 Unauthorized during switch confirmation");
      throw new Error(`switchModel confirmation failed: status ${r2.status}`);
    }

    const loaded = statusEntries(r2.json as OmlxModelsStatusResponse | undefined);
    const targetKeys = new Set(
      [modelId, loadId].map((k) => k.toLowerCase()),
    );
    const found = loaded.some((m) => {
      if (m.loaded !== true) return false;
      if (targetKeys.has(m.id.toLowerCase())) return true;
      if (typeof m.model_alias === "string" && targetKeys.has(m.model_alias.toLowerCase())) return true;
      return false;
    });
    if (!found) {
      throw new Error(
        `model-not-loaded: ${modelId} not found in /v1/models/status after switch`,
      );
    }
  }

  // --- loadUnload -----------------------------------------------------------

  async loadUnload(
    _server: DiscoveredServer,
    cred: ServerCredential,
    modelId: string,
    action: LoadAction,
    probe: Probe,
  ): Promise<void> {
    const headers = authHeaders(cred);

    // Prefer physical/dir id for load|unload when status can resolve an alias.
    let targetId = modelId;
    try {
      const statusR = await probe("/v1/models/status", { headers });
      if (statusR.ok) {
        const maps = buildAliasMaps(statusEntries(statusR.json as OmlxModelsStatusResponse | undefined));
        const physical = maps.toPhysical.get(modelId.toLowerCase());
        if (physical) targetId = physical;
      }
    } catch {
      // Proceed with the caller-supplied id.
    }

    const endpoint = action === "load"
      ? `/v1/models/${encodeURIComponent(targetId)}/load`
      : `/v1/models/${encodeURIComponent(targetId)}/unload`;

    const r = await probe(endpoint, {
      method: "POST",
      headers,
    });
    if (!r.ok) {
      if (r.status === 0) throw new Error(`server unreachable during ${action}`);
      if (r.status === 401) throw new Error(`401 Unauthorized during ${action}`);
      const errorBody = (r.json as { error?: { message?: string } })?.error;
      throw new Error(
        `loadUnload(${action}) failed: ${errorBody?.message ?? `status ${r.status}`}`,
      );
    }
  }

  // --- toPiModel ------------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      // Local inference is free → per-token costs are zero.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      compat: { supportsUsageInStreaming: true },
    };
  }

  // --- inferenceBaseUrl -----------------------------------------------------

  inferenceBaseUrl(server: DiscoveredServer): string {
    return `${server.baseUrl}/v1`;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const omlxAdapter: BackendAdapter = new OmlxAdapter();
