/**
 * llama-swap BackendAdapter
 *
 * llama-swap (mostlygeek/llama-swap) is a proxy front-door for llama-server instances that enables
 * hot-swapping models at runtime. It exposes the llama-swap-specific /running and /upstream/{model}
 * paths that distinguish it from a bare llama-server.
 *
 * Fingerprint: GET /running 200 (JSON) — a path that only llama-swap exposes.
 * Inference base URL: server.baseUrl + "/v1"  (OpenAI + Anthropic compat front door).
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
// Internal types
// ---------------------------------------------------------------------------

interface RunningBody {
  id?: string;
  model?: string;
  models?: string[];
  // llama-swap /running can return a single object or an array of running upstreams
  [key: string]: unknown;
}

interface V1ModelsBody {
  data?: Array<{
    id: string;
    name?: string;
    [key: string]: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when a parsed /running body matches a llama-swap shape — an array of upstreams,
 * or an object carrying one of llama-swap's keys. This positively distinguishes it from
 * LM Studio, whose catch-all 200 response is `{ "error": "Unexpected endpoint..." }` (no
 * such key). Matches every shape {@link parseRunningIds} understands, so it never rejects
 * a real llama-swap server.
 */
function looksLikeRunning(json: unknown): boolean {
  if (Array.isArray(json)) return true;
  if (json === null || typeof json !== "object") return false;
  const o = json as Record<string, unknown>;
  // LM Studio's error sentinel — explicit reject.
  if ("error" in o) return false;
  return "running" in o || "models" in o || "id" in o || "model" in o;
}

/** Extract running model ids from a /running response (handles various shapes). */
function parseRunningIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];

  // Array of running-upstream objects
  if (Array.isArray(json)) {
    return json.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") {
        const id = (item as RunningBody).id ?? (item as RunningBody).model;
        return typeof id === "string" ? [id] : [];
      }
      return [];
    });
  }

  const body = json as RunningBody;

  // { running: [ { model | id, ... }, ... ] } — llama-swap's actual /running shape:
  // a list of running upstreams, each an object carrying the model id.
  if (Array.isArray(body.running)) {
    return body.running.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") {
        const id = (item as RunningBody).model ?? (item as RunningBody).id;
        return typeof id === "string" ? [id] : [];
      }
      return [];
    });
  }

  // { models: [...] }
  if (Array.isArray(body.models)) {
    return body.models.filter((m): m is string => typeof m === "string");
  }

  // { id: "..." }
  if (typeof body.id === "string") return [body.id];

  // { model: "..." }
  if (typeof body.model === "string") return [body.model];

  return [];
}

// ---------------------------------------------------------------------------
// LlamaswapAdapter
// ---------------------------------------------------------------------------

class LlamaswapAdapter implements BackendAdapter {
  readonly kind = "llamaswap" as const;
  readonly displayName = "llama-swap";
  readonly defaultPorts: readonly number[] = [8080];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.IntrospectLoaded,
    Capability.SwitchModel,
    Capability.LoadUnload,
    Capability.Health,
    Capability.Streaming,
    Capability.PerModelCaps,
  ]);

  // --- fingerprint ----------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    // /running is a llama-swap-only path — not present on bare llama-server.
    const r = await probe("/running");
    if (!r.ok) return null;

    // A bare 200-with-JSON is NOT enough: LM Studio answers 200 + a JSON error body
    // (`{"error":"Unexpected endpoint or method. (GET /running)"}`) on EVERY unknown
    // path, which used to false-positive here and mask the real LM Studio backend.
    // Require the body to actually look like llama-swap's /running shape.
    let body: unknown = r.json;
    if (body === undefined && r.text !== undefined) {
      try {
        body = JSON.parse(r.text);
      } catch {
        return null;
      }
    }
    if (!looksLikeRunning(body)) return null;

    return {
      kind: "llamaswap",
      baseUrl,
      auth: "none",
      label: `llama-swap (${baseUrl})`,
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
    if (!r.ok) return { state: "degraded" };

    // llama-swap /health returns plain "OK" text
    const isOk =
      r.text?.trim().toUpperCase() === "OK" ||
      (r.json && typeof r.json === "object" && (r.json as { status?: string }).status === "ok");
    if (!isOk && r.text !== undefined && r.text.trim() !== "") {
      return { state: "degraded" };
    }
    const status: HealthStatus = { state: "healthy" };
    if (r.latencyMs !== undefined) status.latencyMs = r.latencyMs;
    return status;
  }

  // --- helpers --------------------------------------------------------------

  /** Coerce a value to a positive integer, else undefined. */
  private static toPositiveInt(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const n = Number(value);
      return n > 0 ? n : undefined;
    }
    return undefined;
  }

  /** Extract context length from a /v1/models entry (top-level or nested metadata). */
  private static extractContext(entry: Record<string, unknown>): number | undefined {
    const top =
      LlamaswapAdapter.toPositiveInt(entry.context_length) ??
      LlamaswapAdapter.toPositiveInt(entry.max_context_length) ??
      LlamaswapAdapter.toPositiveInt(entry.context_window);
    if (top) return top;

    const meta = entry.meta as Record<string, unknown> | undefined;
    if (meta) {
      const ls = meta.llamaswap as Record<string, unknown> | undefined;
      if (ls) {
        const fromLs =
          LlamaswapAdapter.toPositiveInt(ls.context_length) ??
          LlamaswapAdapter.toPositiveInt(ls.context) ??
          LlamaswapAdapter.toPositiveInt(ls.max_context) ??
          LlamaswapAdapter.toPositiveInt(ls.max_context_length);
        if (fromLs) return fromLs;
      }
      const fromMeta = LlamaswapAdapter.toPositiveInt(meta.n_ctx);
      if (fromMeta) return fromMeta;
    }

    const metadata = entry.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      const fromMd =
        LlamaswapAdapter.toPositiveInt(metadata.context_length) ??
        LlamaswapAdapter.toPositiveInt(metadata.context);
      if (fromMd) return fromMd;
    }

    return undefined;
  }

  /** Extract max tokens from a /v1/models entry. */
  private static extractMaxTokens(entry: Record<string, unknown>): number | undefined {
    const top =
      LlamaswapAdapter.toPositiveInt(entry.output_length) ??
      LlamaswapAdapter.toPositiveInt(entry.max_tokens);
    if (top) return top;
    const meta = entry.meta as Record<string, unknown> | undefined;
    if (meta) {
      const ls = meta.llamaswap as Record<string, unknown> | undefined;
      if (ls) {
        const fromLs =
          LlamaswapAdapter.toPositiveInt(ls.output_length) ??
          LlamaswapAdapter.toPositiveInt(ls.max_tokens);
        if (fromLs) return fromLs;
      }
    }
    return undefined;
  }

  /** Parse -c or --ctx-size from a llama-server command string. */
  private static parseContextFromCmd(cmd: string): number | undefined {
    const m1 = cmd.match(/(?:^|\s)--ctx-size(?:=|\s+)(\d+)/);
    if (m1) return Number(m1[1]);
    const m2 = cmd.match(/(?:^|\s)-c(?:=|\s+)(\d+)/);
    if (m2) return Number(m2[1]);
    return undefined;
  }

  /** Detect whether a model supports vision (image input). */
  private static hasVision(entry: Record<string, unknown>): boolean {
    const arch = entry.architecture as Record<string, unknown> | undefined;
    if (arch?.input_modalities) {
      const mods = arch.input_modalities as string[];
      if (mods.includes("image")) return true;
    }
    const caps = entry.capabilities;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      if ((caps as Record<string, unknown>).vision === true) return true;
    }
    const id = typeof entry.id === "string" ? entry.id.toLowerCase() : "";
    return /vision|multimodal|vl-|clip/.test(id);
  }

  /** Detect whether a model supports reasoning/thinking. */
  private static hasReasoning(entry: Record<string, unknown>): boolean {
    const caps = entry.capabilities;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      if ((caps as Record<string, unknown>).reasoning === true) return true;
    }
    if (Array.isArray(caps)) {
      if (caps.some((c: string) => /reason|thinking/i.test(c))) return true;
    }
    const id = typeof entry.id === "string" ? entry.id.toLowerCase() : "";
    return (
      /(?:^|[-_:/.])(r1|qwq)(?:$|[-_:/.])/.test(id) ||
      id.includes("deepseek-r1") ||
      id.includes("qwen3") ||
      id.includes("gpt-oss") ||
      id.includes("magistral") ||
      id.includes("reasoning") ||
      id.includes("thinking")
    );
  }

  /** Detect whether a model supports tools/function calling. */
  private static hasTools(entry: Record<string, unknown>): boolean {
    const caps = entry.capabilities;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      if ((caps as Record<string, unknown>).function_calling === true) return true;
    }
    const arch = entry.architecture as Record<string, unknown> | undefined;
    if (arch?.supported_parameters) {
      const params = arch.supported_parameters as string[];
      if (params.includes("tools") || params.includes("tool_choice")) return true;
    }
    return false;
  }

  // --- listModels -----------------------------------------------------------

  async listModels(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    const r = await probe("/v1/models");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("listModels failed: server unreachable");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    // Parse /v1/models — entries may carry context_length, metadata, etc.
    const body = r.json as V1ModelsBody | undefined;
    const entries = body?.data ?? [];

    // Build a context map from /running (cmd parsing).
    const ctxMap = new Map<string, number>();
    try {
      const runR = await probe("/running");
      if (runR.ok && runR.json) {
        const runBody = runR.json as { running?: Array<Record<string, unknown>> } | null;
        const processes = runBody?.running ?? [];
        await Promise.all(
          processes.map(async (proc) => {
            const modelId = typeof proc.model === "string" ? proc.model : undefined;
            if (!modelId) return;
            if (typeof proc.cmd === "string") {
              const ctx = LlamaswapAdapter.parseContextFromCmd(proc.cmd);
              if (ctx) ctxMap.set(modelId, ctx);
            }
          }),
        );
      }
    } catch { /* /running is best-effort */ }

    const DEFAULT_CTX = 262144;
    const DEFAULT_MAX = 8192;

    return entries.map((entry) => {
      const entryCtx = LlamaswapAdapter.extractContext(entry as Record<string, unknown>);
      const fromRunning = ctxMap.get(entry.id);
      const contextWindow = entryCtx ?? fromRunning ?? DEFAULT_CTX;
      const maxTokens = LlamaswapAdapter.extractMaxTokens(entry as Record<string, unknown>) ?? DEFAULT_MAX;
      return {
        id: entry.id,
        name: entry.name ?? entry.id,
        contextWindow,
        maxTokens,
        input: LlamaswapAdapter.hasVision(entry as Record<string, unknown>)
          ? (["text", "image"] as ("text" | "image")[])
          : (["text"] as ("text" | "image")[]),
        reasoning: LlamaswapAdapter.hasReasoning(entry as Record<string, unknown>),
        tools: LlamaswapAdapter.hasTools(entry as Record<string, unknown>),
        embeddings: false,
        loaded: false,
      };
    });
  }

  // --- introspectLoaded -----------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const r = await probe("/running");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("introspectLoaded failed: server unreachable");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }
    const ids = parseRunningIds(r.json ?? r.text);
    return {
      loadedModelIds: ids,
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
    // Step 1: GET /upstream/{model} — triggers llama-swap to start that upstream.
    const r1 = await probe(`/upstream/${modelId}`);
    if (!r1.ok) {
      if (r1.status === 0) throw new Error("server unreachable during switchModel");
      if (r1.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`switchModel: upstream request failed: status ${r1.status}`);
    }

    // Step 2: Confirm via GET /running that the target is now active.
    const r2 = await probe("/running");
    if (!r2.ok) {
      if (r2.status === 0) throw new Error("server went down after switch request");
      if (r2.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`switchModel: confirmation probe failed: status ${r2.status}`);
    }
    const runningIds = parseRunningIds(r2.json ?? r2.text);
    if (!runningIds.includes(modelId)) {
      throw new Error(`model-not-loaded: ${modelId} not found in /running after switch`);
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
    if (action === "load") {
      // load: GET /upstream/{model}
      const r = await probe(`/upstream/${modelId}`);
      if (!r.ok) {
        if (r.status === 0) throw new Error("server unreachable during load");
        if (r.status === 401) throw new Error("401 Unauthorized");
        throw new Error(`loadUnload(load) failed: status ${r.status}`);
      }
    } else {
      // unload: POST /api/models/unload
      const r = await probe(`/api/models/unload`, {
        method: "POST",
        body: JSON.stringify({ model: modelId }),
        headers: { "content-type": "application/json" },
      });
      if (!r.ok) {
        if (r.status === 0) throw new Error("server unreachable during unload");
        if (r.status === 401) throw new Error("401 Unauthorized");
        throw new Error(`loadUnload(unload) failed: status ${r.status}`);
      }
    }
  }

  // --- perModelCaps ---------------------------------------------------------

  async perModelCaps(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
    modelId: string,
  ): Promise<Partial<ModelDescriptor>> {
    // Return cached capabilities from listModels (already computed above).
    // This is a no-op here since listModels already enriches each entry.
    return {};
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
      contextWindow: model.contextWindow ?? 262144,
      maxTokens: model.maxTokens ?? 8192,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
        supportsUsageInStreaming: true,
      },
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

export const llamaswapAdapter: BackendAdapter = new LlamaswapAdapter();
