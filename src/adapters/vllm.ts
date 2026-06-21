/**
 * vLLM backend adapter for Crossbar.
 *
 * Implements the BackendAdapter contract for vLLM's OpenAI-compatible HTTP API:
 *   - Fingerprint: GET /version → {"version":...} AND/OR GET /v1/models with owned_by:"vllm"
 *   - List models: GET /v1/models → ModelCard[] {id, max_model_len, owned_by, root}
 *   - Health: GET /health (empty 200 ⇒ healthy, 503 ⇒ loading)
 *   - Inference base URL: server.baseUrl + "/v1"
 *
 * Capabilities NOT declared (vLLM serves a single fixed model at startup):
 *   - IntrospectLoaded — no live introspection endpoint for the base model
 *   - SwitchModel — no hot-swap on the base model
 *   - LoadUnload — no explicit load/unload on the base model
 *
 * Uses ONLY the injected Probe — never calls fetch directly.
 */

import { Capability } from "../core/capability.ts";
import type { BackendAdapter, PiApiType } from "../core/backend-adapter.ts";
import type {
  DiscoveredServer,
  HealthStatus,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ServerCredential,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shapes matching vLLM's API responses
// ---------------------------------------------------------------------------

interface VllmVersionResponse {
  version?: string;
}

interface VllmModelCard {
  id: string;
  owned_by?: string;
  max_model_len?: number;
  root?: string;
  parent?: string | null;
}

interface VllmModelsResponse {
  data?: VllmModelCard[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// VllmAdapter
// ---------------------------------------------------------------------------

class VllmAdapter implements BackendAdapter {
  readonly kind = "vllm" as const;
  readonly displayName = "vLLM";
  readonly defaultPorts: readonly number[] = [8000];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.Health,
    Capability.PerModelCaps,
    Capability.Streaming,
  ]);

  // --- fingerprint ----------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    // Strategy 1: GET /version → {"version": ...} unique to vLLM
    const versionResult = await probe("/version");
    if (versionResult.status !== 0) {
      if (versionResult.ok) {
        const body = versionResult.json as VllmVersionResponse | undefined;
        if (body && typeof body.version === "string") {
          // /version responded with a version string → high confidence vLLM
          return {
            kind: "vllm",
            baseUrl,
            auth: "none",
            version: body.version,
            label: `vLLM (${baseUrl.replace(/^https?:\/\//, "")})`,
            confidence: 0.9,
          };
        }
      }
    }

    // Strategy 2: GET /v1/models with owned_by:"vllm" and max_model_len
    const modelsResult = await probe("/v1/models");
    if (modelsResult.status === 0) return null;
    if (!modelsResult.ok) return null;

    const body = modelsResult.json as VllmModelsResponse | undefined;
    const models = body?.data ?? [];
    const hasVllmModel = models.some(
      (m) => m.owned_by === "vllm" && typeof m.max_model_len === "number",
    );
    if (!hasVllmModel) return null;

    return {
      kind: "vllm",
      baseUrl,
      auth: "none",
      label: `vLLM (${baseUrl.replace(/^https?:\/\//, "")})`,
      confidence: 0.9,
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
    if (r.status === 503) return { state: "loading" };
    if (!r.ok) return { state: "degraded", detail: `status ${r.status}` };
    const status: HealthStatus = { state: "healthy" };
    if (r.latencyMs !== undefined) status.latencyMs = r.latencyMs;
    return status;
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

    const r = await probe("/v1/models", { method: "GET", headers });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    const body = r.json as VllmModelsResponse | undefined;
    const rawModels = body?.data ?? [];

    return rawModels.map((m): ModelDescriptor => {
      return {
        id: m.id,
        name: m.id,
        contextWindow: typeof m.max_model_len === "number" ? m.max_model_len : DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: ["text"],
        reasoning: false,
        embeddings: false,
        raw: m,
      };
    });
  }

  // --- toPiModel ------------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
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

export const vllmAdapter: BackendAdapter = new VllmAdapter();
