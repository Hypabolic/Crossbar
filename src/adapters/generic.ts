/**
 * Generic OpenAI-compatible backend adapter for Crossbar.
 *
 * Catch-all fallback for the long tail: TabbyAPI, KoboldCpp, oobabooga, Jan, llamafile,
 * and any unknown server that merely exposes `/v1/models`. Specific adapters (ollama,
 * lmstudio, llamacpp, vllm, ...) run first and win at higher confidence; this adapter
 * takes what remains.
 *
 * Capabilities: ListModels + Streaming ONLY.
 * Fingerprint: GET /v1/models → 200 + `data` array → LOW confidence ~0.3 so any
 * specific adapter outranks it.
 *
 * Uses ONLY the injected Probe — never calls fetch directly.
 */

import { Capability } from "../core/capability.ts";
import type { BackendAdapter, PiApiType } from "../core/backend-adapter.ts";
import type {
  DiscoveredServer,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ServerCredential,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Conservative defaults — applied when the backend doesn't report metadata
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a user-supplied base URL so it ends with "/v1".
 * If the URL already ends with "/v1" it is returned unchanged.
 * A trailing slash before "/v1" is accepted (e.g. "http://host:8080/" → "http://host:8080/v1").
 */
function normaliseToV1(url: string): string {
  // Strip a single trailing slash before testing.
  const stripped = url.endsWith("/") ? url.slice(0, -1) : url;
  if (stripped.endsWith("/v1")) return stripped;
  return `${stripped}/v1`;
}

// ---------------------------------------------------------------------------
// GenericAdapter
// ---------------------------------------------------------------------------

class GenericAdapter implements BackendAdapter {
  readonly kind = "openai-generic" as const;
  readonly displayName = "OpenAI-compatible";
  /** Empty — the engine tries specific adapters first; generic is the fallback. */
  readonly defaultPorts: readonly number[] = [];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.Streaming,
  ]);

  // --- fingerprint ----------------------------------------------------------

  /**
   * Probe GET /v1/models. Returns a DiscoveredServer at LOW confidence (~0.3) when the
   * response is 200 with a non-empty `data` array of objects. Returns null otherwise.
   *
   * Low confidence is intentional: any origin that also has a more specific response
   * (Ollama root text, LM Studio /api/v0/models, vLLM /version, etc.) will be matched
   * at higher confidence by its specific adapter, which the engine prefers.
   */
  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    const r = await probe("/v1/models");
    if (!r.ok || r.status === 0) return null;

    const body = r.json as { data?: unknown[] } | undefined;
    if (!Array.isArray(body?.data)) return null;

    return {
      kind: "openai-generic",
      baseUrl,
      auth: "none",
      label: `OpenAI-compatible (${baseUrl})`,
      confidence: 0.3,
    };
  }

  // --- listModels -----------------------------------------------------------

  /**
   * GET /v1/models → map data[].id to ModelDescriptor.
   * Conservative defaults are applied (contextWindow 8192, maxTokens 4096, input ["text"]).
   * Common embedding/reranking model families are excluded from chat registration.
   * Throws on non-ok / 401 / status:0.
   */
  async listModels(
    server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      // Never log the key — inject header only.
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }

    const r = await probe("/v1/models", { headers });

    if (r.status === 401) throw new Error("401 Unauthorized: invalid or missing API key");
    if (r.status === 0) throw new Error("listModels failed: server unreachable (status 0)");
    if (!r.ok) throw new Error(`listModels failed: HTTP ${r.status}`);

    const body = r.json as { data?: Array<{ id?: unknown }> } | undefined;
    if (!Array.isArray(body?.data)) return [];

    return body.data
      .filter((item): item is { id: string } => typeof item?.id === "string")
      .map((item): ModelDescriptor => {
        const normalizedId = item.id.toLowerCase();
        const isEmbedding =
          /(^|[/:._-])(embed|embedding|bge|gte|e5|reranker)([/:._-]|$)/.test(normalizedId) ||
          normalizedId.includes("nomic-embed");
        return {
          id: item.id,
          name: item.id,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
          input: ["text"],
          reasoning: false,
          embeddings: isEmbedding,
          raw: item,
        };
      });
  }

  // --- toPiModel ------------------------------------------------------------

  toPiModel(server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      // Local inference is free → per-token costs are zero, but cache-hit token
      // COUNTS still matter: Pi maps any `usage.prompt_tokens_details.cached_tokens` the
      // backend reports to `Usage.cacheRead` and displays it regardless of cost. The
      // flag only asks for usage in streaming (never fabricates), so it is safe even for
      // unknown OpenAI-compatible servers that may not report cache hits.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      compat: { supportsUsageInStreaming: true },
    };
  }

  // --- inferenceBaseUrl -----------------------------------------------------

  /**
   * Returns server.baseUrl normalised to end with "/v1".
   * Pi needs this to resolve `/v1/chat/completions` correctly.
   */
  inferenceBaseUrl(server: DiscoveredServer): string {
    return normaliseToV1(server.baseUrl);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const genericAdapter: BackendAdapter = new GenericAdapter();
