/**
 * Ollama backend adapter for Crossbar.
 *
 * Implements the full BackendAdapter contract against Ollama's native HTTP API:
 *   - Fingerprint: GET / → "Ollama is running"
 *   - List models: GET /api/tags + per-model POST /api/show for caps
 *   - Introspect loaded: GET /api/ps
 *   - Switch model: POST /api/generate {keep_alive:"5m"} then confirm via GET /api/ps
 *   - Load/unload: POST /api/generate {keep_alive:"5m"} / {keep_alive:0}
 *   - Health: GET /
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
// Internal shapes matching Ollama's API responses
// ---------------------------------------------------------------------------

interface OllamaTagsModel {
  name: string;
  model?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagsModel[];
}

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

interface OllamaPsModel {
  name?: string;
  model?: string;
  expires_at?: string;
  size_vram?: number;
}

interface OllamaPsResponse {
  models?: OllamaPsModel[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// OllamaAdapter
// ---------------------------------------------------------------------------

class OllamaAdapter implements BackendAdapter {
  readonly kind = "ollama" as const;
  readonly displayName = "Ollama";
  readonly defaultPorts: readonly number[] = [11434];
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

  // --- fingerprint ----------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    const r = await probe("/");
    // status:0 means connection refused / unreachable → not our backend
    if (r.status === 0) return null;
    // Must be a 200 OK with the sentinel text
    if (!r.ok) return null;
    const body = r.text ?? "";
    if (!body.includes("Ollama is running")) return null;

    // High confidence: the text sentinel is unique to Ollama
    return {
      kind: "ollama",
      baseUrl,
      auth: "none",
      label: `Ollama (${baseUrl.replace(/^https?:\/\//, "")})`,
      confidence: 0.95,
    };
  }

  // --- health ---------------------------------------------------------------

  async health(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<HealthStatus> {
    const r = await probe("/");
    if (r.status === 0) {
      const status: HealthStatus = { state: "unreachable" };
      if (r.error !== undefined) status.detail = r.error;
      return status;
    }
    if (r.status === 401) return { state: "unauthorized" };
    if (!r.ok) return { state: "degraded", detail: `status ${r.status}` };
    const status: HealthStatus = { state: "healthy" };
    if (r.latencyMs !== undefined) status.latencyMs = r.latencyMs;
    return status;
  }

  // --- listModels -----------------------------------------------------------

  async listModels(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    const r = await probe("/api/tags", { method: "GET" });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    const body = r.json as OllamaTagsResponse | undefined;
    const rawModels = body?.models ?? [];

    const descriptors: ModelDescriptor[] = await Promise.all(
      rawModels.map(async (m) => {
        const modelId = m.model ?? m.name;
        const caps = await this._fetchModelCaps(modelId, probe);
        return caps;
      }),
    );

    return descriptors;
  }

  /** Fetch /api/show for a single model and build its ModelDescriptor. */
  private async _fetchModelCaps(modelId: string, probe: Probe): Promise<ModelDescriptor> {
    const defaults: ModelDescriptor = {
      id: modelId,
      name: modelId,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      input: ["text"],
      reasoning: false,
      tools: false,
      embeddings: false,
    };

    try {
      const r = await probe("/api/show", {
        method: "POST",
        body: JSON.stringify({ name: modelId }),
        headers: { "content-type": "application/json" },
      });
      if (!r.ok) return defaults;

      const show = r.json as OllamaShowResponse | undefined;
      if (!show) return defaults;

      const caps = show.capabilities ?? [];
      const hasVision = caps.includes("vision");
      const hasTools = caps.includes("tools");
      const hasThinking = caps.includes("thinking");
      const isEmbedding = caps.includes("embedding");

      // Extract context length from model_info: look for any key ending in ".context_length"
      let contextWindow = DEFAULT_CONTEXT_WINDOW;
      if (show.model_info) {
        for (const [key, val] of Object.entries(show.model_info)) {
          if (key.endsWith(".context_length") && typeof val === "number" && val > 0) {
            contextWindow = val;
            break;
          }
        }
      }

      return {
        id: modelId,
        name: modelId,
        contextWindow,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: hasVision ? ["text", "image"] : ["text"],
        reasoning: hasThinking,
        tools: hasTools,
        embeddings: isEmbedding,
        raw: show,
      };
    } catch {
      // /api/show might not exist or might error — fall back to defaults
      return defaults;
    }
  }

  // --- introspectLoaded -----------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const r = await probe("/api/ps", { method: "GET" });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }

    const body = r.json as OllamaPsResponse | undefined;
    const loaded = body?.models ?? [];

    const loadedModelIds: string[] = loaded
      .map((m) => m.model ?? m.name ?? "")
      .filter((id) => id.length > 0);

    const perModel: Record<string, { vramBytes?: number; expiresAt?: number }> = {};
    for (const m of loaded) {
      const id = m.model ?? m.name ?? "";
      if (!id) continue;
      const info: { vramBytes?: number; expiresAt?: number } = {};
      if (m.size_vram !== undefined) info.vramBytes = m.size_vram;
      if (m.expires_at) {
        const ms = new Date(m.expires_at).getTime();
        if (!isNaN(ms)) info.expiresAt = ms;
      }
      perModel[id] = info;
    }

    return {
      loadedModelIds,
      perModel,
      source: "introspection",
    };
  }

  // --- switchModel ----------------------------------------------------------

  async switchModel(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    modelId: string,
    probe: Probe,
  ): Promise<void> {
    // Step 1: trigger load by sending a generate request with keep_alive:"5m"
    const r1 = await probe("/api/generate", {
      method: "POST",
      body: JSON.stringify({ model: modelId, keep_alive: "5m" }),
      headers: { "content-type": "application/json" },
    });
    if (!r1.ok) {
      if (r1.status === 0) throw new Error("server unreachable during switch");
      if (r1.status === 401) throw new Error("401 Unauthorized during switch");
      throw new Error(`switchModel generate failed: status ${r1.status}`);
    }

    // Step 2: confirm via /api/ps that the model is now loaded
    const r2 = await probe("/api/ps", { method: "GET" });
    if (!r2.ok) {
      if (r2.status === 0) throw new Error("server went down after switch request");
      if (r2.status === 401) throw new Error("401 Unauthorized during switch confirmation");
      throw new Error(`switchModel confirmation failed: status ${r2.status}`);
    }

    const body = r2.json as OllamaPsResponse | undefined;
    const loaded = body?.models ?? [];
    const loadedIds = loaded.map((m) => m.model ?? m.name ?? "");
    if (!loadedIds.includes(modelId)) {
      throw new Error(`model-not-loaded: ${modelId} not found in /api/ps after switch`);
    }
  }

  // --- loadUnload -----------------------------------------------------------

  async loadUnload(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    modelId: string,
    action: LoadAction,
    probe: Probe,
  ): Promise<void> {
    const keepAlive = action === "load" ? "5m" : 0;
    const r = await probe("/api/generate", {
      method: "POST",
      body: JSON.stringify({ model: modelId, keep_alive: keepAlive }),
      headers: { "content-type": "application/json" },
    });
    if (!r.ok) {
      if (r.status === 0) throw new Error(`server unreachable during ${action}`);
      if (r.status === 401) throw new Error(`401 Unauthorized during ${action}`);
      throw new Error(`loadUnload(${action}) failed: status ${r.status}`);
    }
  }

  // --- toPiModel -----------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      // Local inference is free → per-token costs are zero, but cache-hit token
      // COUNTS still matter: Pi maps the backend's `usage.prompt_tokens_details
      // .cached_tokens` to `Usage.cacheRead` and displays it regardless of cost. Keep
      // streaming usage reporting on so those prompt-cache hits are recorded.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      compat: { supportsUsageInStreaming: true },
    };
  }

  // --- inferenceBaseUrl ----------------------------------------------------

  inferenceBaseUrl(server: DiscoveredServer): string {
    return `${server.baseUrl}/v1`;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const ollamaAdapter: BackendAdapter = new OllamaAdapter();
