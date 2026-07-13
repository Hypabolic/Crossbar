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
    n_ctx?: number | null;
    params?: {
      n_predict?: number | null;
      max_tokens?: number | null;
    } | null;
    /** Older llama-server payloads exposed this directly instead of under params. */
    n_predict?: number | null;
  } | null;
  build_info?: unknown;
  model_path?: string;
  modalities?: string[];
}

interface V1ModelsBody {
  data?: Array<{
    id: string;
    meta?: {
      n_ctx?: number | null;
      n_ctx_train?: number | null;
    } | null;
    status?: {
      args?: string[] | null;
    } | null;
  }>;
}

function basename(path: string): string {
  // Extract the last path segment, dropping any trailing slash.
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function firstPositiveSafeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const positive = positiveSafeInteger(value);
    if (positive !== undefined) return positive;
  }
  return undefined;
}

function positiveIntegerArg(
  args: readonly string[] | null | undefined,
  names: readonly string[],
): number | undefined {
  if (!Array.isArray(args)) return undefined;

  let found: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== "string") continue;

    let rawValue: string | undefined;
    if (names.includes(arg)) {
      rawValue = args[index + 1];
      index++;
    } else {
      for (const name of names) {
        const prefix = `${name}=`;
        if (arg.startsWith(prefix)) {
          rawValue = arg.slice(prefix.length);
          break;
        }
      }
    }

    if (rawValue === undefined) continue;
    const value = positiveSafeInteger(Number(rawValue));
    if (value !== undefined) found = value;
  }
  return found;
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

    // Fetch root /props once. It reports effective runtime defaults for a
    // single-server row, but is not per-model context in router mode.
    const propsResult = await probe("/props");
    const props = propsResult.ok ? (propsResult.json as PropsBody | undefined) : undefined;
    const propsNCtx = positiveSafeInteger(props?.default_generation_settings?.n_ctx);
    const propsParams = props?.default_generation_settings?.params;
    const propsMaxTokens = firstPositiveSafeInteger(
      propsParams?.n_predict,
      propsParams?.max_tokens,
      props?.default_generation_settings?.n_predict,
    );
    const hasVision = Array.isArray(props?.modalities) &&
      props.modalities.some((m) => m.toLowerCase().includes("vision") || m.toLowerCase().includes("image"));

    return data.map((entry) => {
      const isRouterRow = entry.status != null;
      const contextWindow = firstPositiveSafeInteger(
        entry.meta?.n_ctx,
        isRouterRow ? undefined : propsNCtx,
        positiveIntegerArg(entry.status?.args, ["-c", "--ctx-size"]),
        entry.meta?.n_ctx_train,
      );
      const maxTokens = firstPositiveSafeInteger(
        positiveIntegerArg(entry.status?.args, ["-n", "--predict", "--n-predict"]),
        propsMaxTokens,
      );
      const descriptor: ModelDescriptor = {
        id: entry.id,
        name: entry.id,
        input: hasVision ? ["text", "image"] : ["text"],
        reasoning: false,
      };
      if (contextWindow !== undefined) descriptor.contextWindow = contextWindow;
      if (maxTokens !== undefined) descriptor.maxTokens = maxTokens;
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
      contextWindow: positiveSafeInteger(model.contextWindow) ?? 128_000,
      maxTokens: positiveSafeInteger(model.maxTokens) ?? 0,
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
