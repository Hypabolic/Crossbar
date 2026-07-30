/**
 * oMLX backend adapter for Crossbar.
 *
 * oMLX is a local LLM inference server optimized for Apple Silicon that exposes
 * OpenAI-compatible and Anthropic-compatible API endpoints at port 8000.
 *
 * Implements the BackendAdapter contract for oMLX's OpenAI-compatible HTTP API:
 *   - Fingerprint: GET /v1/models with owned_by:"omlx" and max_model_len
 *   - List models: GET /v1/models → ModelCard[] {id, max_model_len, owned_by, object, created}
 *   - Health: GET /health (empty 200 ⇒ healthy, no auth required)
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
}

interface OmlxModelsResponse {
  object?: string;
  data?: OmlxModelCard[];
}

interface OmlxLoadedModelInfo {
  id: string;
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
  models?: OmlxLoadedModelInfo[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 4096;

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
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }

    const r = await probe("/v1/models", { headers });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    const body = r.json as OmlxModelsResponse | undefined;
    const rawModels = body?.data ?? [];

    // Enrich with thinking capability from the status endpoint (when available).
    let thinkingMap: Record<string, boolean> = {};
    try {
      const statusR = await probe("/v1/models/status", { headers });
      if (statusR.ok) {
        const statusBody = statusR.json as OmlxModelsStatusResponse | undefined;
        const statusData = (statusBody as { models?: OmlxLoadedModelInfo[] }).models ?? statusBody?.data ?? [];
        thinkingMap = Object.fromEntries(
          statusData.map((m) => [m.id, m.thinking_default === true]),
        );
      }
    } catch {
      // Status endpoint may not exist or be reachable — fall back to no-thinking.
    }

    return rawModels.map((m): ModelDescriptor => {
      return {
        id: m.id,
        name: m.id,
        contextWindow: typeof m.max_model_len === "number" ? m.max_model_len : DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: ["text"],
        reasoning: thinkingMap[m.id] ?? false,
        embeddings: false,
        raw: m,
      };
    });
  }

  // --- introspectLoaded -----------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }

    const r = await probe("/v1/models/status", { headers });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }

    const body = r.json as OmlxModelsStatusResponse | undefined;
    const statusData = (body as { models?: OmlxLoadedModelInfo[] }).models ?? body?.data ?? [];

    // Use per-model caps from the richer status response when available.
    const loadedModelIds: string[] = [];
    const perModel: Record<string, { vramBytes?: number; expiresAt?: number }> = {};

    for (const m of statusData) {
      if (m.loaded === true) {
        loadedModelIds.push(m.id);
        const info: { vramBytes?: number; expiresAt?: number } = {};
        if (m.actual_size !== undefined) info.vramBytes = m.actual_size;
        perModel[m.id] = info;
      }
    }

    return {
      loadedModelIds,
      perModel: Object.keys(perModel).length > 0 ? perModel : undefined,
      source: "introspection",
    };
  }

  // --- switchModel ----------------------------------------------------------

  async switchModel(
    _server: DiscoveredServer,
    cred: ServerCredential,
    modelId: string,
    probe: Probe,
  ): Promise<void> {
    // Step 1: trigger load by POSTing to /v1/models/{id}/load
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }

    const r1 = await probe(`/v1/models/${encodeURIComponent(modelId)}/load`, {
      method: "POST",
      headers,
    });
    if (!r1.ok) {
      if (r1.status === 0) throw new Error("server unreachable during switch");
      if (r1.status === 401) throw new Error("401 Unauthorized during switch");
      // oMLX returns {error: {message, type}} on failure — include it for debugging
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

    const body = r2.json as OmlxModelsStatusResponse | undefined;
    const loaded = (body as { models?: OmlxLoadedModelInfo[] }).models ?? body?.data ?? [];
    const loadedIds = loaded.filter((m) => m.loaded === true).map((m) => m.id);
    if (!loadedIds.includes(modelId)) {
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
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }

    const endpoint = action === "load"
      ? `/v1/models/${encodeURIComponent(modelId)}/load`
      : `/v1/models/${encodeURIComponent(modelId)}/unload`;

    const r = await probe(endpoint, {
      method: "POST",
      headers,
    });
    if (!r.ok) {
      if (r.status === 0) throw new Error(`server unreachable during ${action}`);
      if (r.status === 401) throw new Error(`401 Unauthorized during ${action}`);
      // oMLX returns {error: {message, type}} on failure — include it for debugging
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
