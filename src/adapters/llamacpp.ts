/**
 * llama.cpp (llama-server) BackendAdapter
 *
 * Covers a single-model llama-server instance. No hot-swap (SwitchModel / LoadUnload absent).
 * Fingerprinted via GET /props with `default_generation_settings` + `build_info`.
 * Inference base URL: server.baseUrl + "/v1"  (OpenAI-compat endpoint).
 */

import { Capability } from "../core/capability.ts";
import type { BackendAdapter, PiApiType } from "../core/backend-adapter.ts";
import type {
  DiscoveredServer,
  HealthStatus,
  LoadedState,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ServerCredential,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PropsBody {
  default_generation_settings?: {
    n_ctx?: number;
  };
  build_info?: unknown;
  model_path?: string;
  modalities?: string[];
}

interface V1ModelsBody {
  data?: Array<{
    id: string;
    meta?: {
      n_ctx_train?: number;
    };
  }>;
}

function basename(path: string): string {
  // Extract the last path segment, dropping any trailing slash.
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// ---------------------------------------------------------------------------
// LlamacppAdapter
// ---------------------------------------------------------------------------

class LlamacppAdapter implements BackendAdapter {
  readonly kind = "llamacpp" as const;
  readonly displayName = "llama.cpp";
  readonly defaultPorts: readonly number[] = [8080];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.IntrospectLoaded,
    Capability.Health,
    Capability.PerModelCaps,
    Capability.Streaming,
  ]);

  // --- fingerprint ----------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    const r = await probe("/props");
    if (!r.ok) return null;
    const body = r.json as PropsBody | undefined;
    if (!body?.default_generation_settings) return null;
    if (!("build_info" in (body as object))) return null;
    return {
      kind: "llamacpp",
      baseUrl,
      auth: "none",
      label: `llama.cpp (${baseUrl})`,
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
    if (r.status === 0) return { state: "unreachable" };
    if (r.status === 401) return { state: "unauthorized" };
    if (!r.ok) {
      // llama-server returns 503 while loading
      if (r.status === 503) return { state: "loading" };
      return { state: "degraded" };
    }
    const body = r.json as { status?: string } | undefined;
    if (body?.status === "loading") return { state: "loading" };
    const status: HealthStatus = { state: "healthy" };
    if (r.latencyMs !== undefined) status.latencyMs = r.latencyMs;
    return status;
  }

  // --- listModels -----------------------------------------------------------

  async listModels(
    server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    // Fetch /v1/models
    const r = await probe("/v1/models");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("listModels failed: server unreachable");
      throw new Error(`listModels failed: status ${r.status}`);
    }
    const body = r.json as V1ModelsBody | undefined;
    const data = body?.data ?? [];

    // Fetch /props for context window and model_path
    const propsResult = await probe("/props");
    const props = propsResult.ok ? (propsResult.json as PropsBody | undefined) : undefined;
    const propsNCtx = props?.default_generation_settings?.n_ctx;
    const hasVision = Array.isArray(props?.modalities) &&
      props!.modalities!.some((m) => m.toLowerCase().includes("vision") || m.toLowerCase().includes("image"));

    return data.map((entry) => {
      const contextWindow =
        propsNCtx ??
        entry.meta?.n_ctx_train ??
        8192;
      const descriptor: ModelDescriptor = {
        id: entry.id,
        name: entry.id,
        contextWindow,
        maxTokens: 4096,
        input: hasVision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
        reasoning: false,
      };
      return descriptor;
    });
  }

  // --- introspectLoaded -----------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const r = await probe("/props");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("introspectLoaded failed: server unreachable");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }
    const body = r.json as PropsBody | undefined;
    const modelPath = body?.model_path;

    if (!modelPath) {
      return { loadedModelIds: [], source: "introspection" };
    }

    // Try to match model_path to a /v1/models id. The id is typically the basename.
    const modelBase = basename(modelPath);

    // Also fetch /v1/models to find the matching id
    const modelsResult = await probe("/v1/models");
    let matchedId = modelBase;
    if (modelsResult.ok) {
      const modelsBody = modelsResult.json as V1ModelsBody | undefined;
      const data = modelsBody?.data ?? [];
      // Find a model whose id matches the path basename (exact or suffix)
      const found = data.find(
        (m) => m.id === modelBase || m.id === modelPath || modelPath.endsWith(m.id),
      );
      if (found) {
        matchedId = found.id;
      } else if (data.length === 1 && data[0]) {
        // Single model — use it regardless
        matchedId = data[0].id;
      }
    }

    return {
      loadedModelIds: [matchedId],
      source: "introspection",
    };
  }

  // --- toPiModel ------------------------------------------------------------

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
      contextWindow: model.contextWindow ?? 8192,
      maxTokens: model.maxTokens ?? 4096,
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

export const llamacppAdapter: BackendAdapter = new LlamacppAdapter();
