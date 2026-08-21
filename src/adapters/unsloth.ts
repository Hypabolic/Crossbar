/**
 * Unsloth Studio backend adapter for Crossbar.
 *
 * Unsloth Studio (https://unsloth.ai) serves an OpenAI/Anthropic-compatible surface
 * (`/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/completions`,
 * `/v1/embeddings`). Unlike most local backends, it has NO unauthenticated mode: every
 * request — including `GET /v1/models` — requires `Authorization: Bearer sk-unsloth-…`.
 *
 * `authRequired: true` tells the onboarding flow this backend can never be added with
 * `auth: "none"` — see ARCHITECTURE.md and the BackendAdapter contract.
 *
 * # Fingerprint discriminator — verified against a live instance (2026-08-19)
 *
 * Unsloth Studio sets `Server: unsloth-studio` on EVERY response — 200, 401 with no
 * Authorization header, and 401 with a wrong/expired key alike. Confirmed via curl against a
 * running server:
 *
 *   $ curl -sD- https://<host>:8888/v1/models                                 # no header
 *   HTTP/2 401
 *   server: unsloth-studio
 *   www-authenticate: Bearer
 *   {"error":{"message":"Not authenticated","type":"authentication_error","param":null,"code":null}}
 *
 *   $ curl -sD- https://<host>:8888/v1/models -H "Authorization: Bearer sk-unsloth-…"
 *   HTTP/2 200
 *   server: unsloth-studio
 *   {"object":"list","data":[{"id":"unsloth/Qwen3.8-27B-GGUF","owned_by":"unsloth-studio",
 *     "quant":"UD-Q4_K_XL","context_length":49152,"max_context_length":229888,
 *     "native_context_length":262144,"loaded":true}, ...]}
 *
 * This is a real, explicit, always-present product header — a MUCH stronger discriminator
 * than guessing at error-message wording (an earlier version of this adapter tried to match
 * a hypothetical FastAPI `{"detail": "Missing authentication token"}` 401 body, which turned
 * out not to match the actual server at all: the real 401 body is an OpenAI-style
 * `{"error": {"type": "authentication_error", ...}}` envelope instead). The `Server` header
 * lets `fingerprint()` positively identify Unsloth Studio — AND flag that it needs a key —
 * from a single unauthenticated probe, before the user has entered a working key at all,
 * instead of falling through every adapter to the generic "could not identify the server"
 * dead end. Each model entry in the authenticated `data[]` also self-reports
 * `owned_by: "unsloth-studio"` and a `loaded: boolean` residency flag, used below for
 * IntrospectLoaded.
 *
 * Uses ONLY the injected Probe — never calls fetch directly.
 */

import { Capability } from "../core/capability.ts";
import type { BackendAdapter, PiApiType } from "../core/backend-adapter.ts";
import type {
  DiscoveredServer,
  LoadedState,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ServerCredential,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

interface UnslothModelEntry {
  id: string;
  owned_by?: string;
  quant?: string;
  display_name?: string;
  /** Currently-configured context for a loaded model. Absent when not loaded. */
  context_length?: number;
  /** Usable context ceiling (may be less than native due to available VRAM/RAM). */
  max_context_length?: number;
  /** The model's absolute trained/architectural context length. */
  native_context_length?: number;
  loaded?: boolean;
}

interface UnslothModelsResponse {
  data?: UnslothModelEntry[];
}

/** The literal header value Unsloth Studio sets on every response. */
const SERVER_HEADER_VALUE = "unsloth-studio";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unsloth Studio's documented default port (`UNSLOTH_STUDIO_URL` default). */
const DEFAULT_PORT = 8888;

/**
 * Fallback context used ONLY at the Pi-mapping boundary, where the field is mandatory and a
 * model with no known context would otherwise be unusable. Matches the llama.cpp/llama-swap
 * adapters. `maxTokens: 0` means "no client-side cap — let the server decide".
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 0;

function isUnslothStudioResponse(headers: Record<string, string>): boolean {
  // Probe lowercases header names AND we compare the value case-insensitively — cheap
  // insurance against a future casing change upstream, no behavioural cost today.
  const server = headers["server"];
  return typeof server === "string" && server.toLowerCase() === SERVER_HEADER_VALUE;
}

function isEmbeddingId(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    /(^|[/:._-])(embed|embedding|bge|gte|e5|reranker)([/:._-]|$)/.test(normalized) ||
    normalized.includes("nomic-embed")
  );
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Prefer the model's currently-configured context (only present while loaded), then the
 * usable ceiling, then the architectural native max.
 *
 * Returns `undefined` — NOT a fabricated default — when the server reports none of them.
 * Verified against a live instance: Unsloth Studio emits the three `*context_length` fields
 * ONLY for models that are currently loaded; every unloaded entry carries no context
 * information at all. Inventing a number here (this used to return 8192) baked a bogus
 * "8k ctx" into both the model picker and the `lastKnownModels` cache in crossbar.json for
 * every unloaded model — including 262144-context ones. Same rule as the llama.cpp and
 * llama-swap adapters: report only what the backend actually said, and let `toPiModel`
 * apply the single, clearly-marked fallback.
 */
function contextWindowFor(entry: UnslothModelEntry): number | undefined {
  return (
    positiveSafeInteger(entry.context_length) ??
    positiveSafeInteger(entry.max_context_length) ??
    positiveSafeInteger(entry.native_context_length)
  );
}

// ---------------------------------------------------------------------------
// UnslothAdapter
// ---------------------------------------------------------------------------

class UnslothAdapter implements BackendAdapter {
  readonly kind = "unsloth" as const;
  readonly displayName = "Unsloth Studio";
  readonly defaultPorts: readonly number[] = [DEFAULT_PORT];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.IntrospectLoaded,
    Capability.Streaming,
  ]);
  /** Unsloth Studio rejects every request — including GET /v1/models — without a valid key. */
  readonly authRequired = true;

  // --- fingerprint ------------------------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    const r = await probe("/v1/models");
    if (r.status === 0) return null;

    // The `Server: unsloth-studio` header is present on every response this backend gives,
    // authenticated or not — the one thing that's actually unique to this product (see the
    // header comment above for a verified capture of both branches).
    if (!isUnslothStudioResponse(r.headers)) return null;

    return {
      kind: "unsloth",
      baseUrl,
      // The backend requires a key unconditionally, regardless of whether THIS particular
      // probe happened to carry a working one.
      auth: "apiKey",
      label: `Unsloth Studio (${baseUrl.replace(/^https?:\/\//, "")})`,
      confidence: 0.95,
    };
  }

  // --- listModels ---------------------------------------------------------------------------

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

    if (r.status === 401) throw new Error("401 Unauthorized: invalid or missing Unsloth API key");
    if (r.status === 0) throw new Error("listModels failed: server unreachable (status 0)");
    if (!r.ok) throw new Error(`listModels failed: HTTP ${r.status}`);

    const body = r.json as UnslothModelsResponse | undefined;
    if (!Array.isArray(body?.data)) return [];

    return body.data
      .filter((entry): entry is UnslothModelEntry => typeof entry?.id === "string")
      .map((entry): ModelDescriptor => {
        const contextWindow = contextWindowFor(entry);
        const descriptor: ModelDescriptor = {
          id: entry.id,
          name: entry.display_name ?? entry.id,
          input: ["text"],
          reasoning: false,
          embeddings: isEmbeddingId(entry.id),
          loaded: entry.loaded === true,
          raw: entry,
        };
        // Omitted entirely when unknown, so the cached descriptor never asserts a context
        // the server did not report — and picks up the real value once the model is loaded.
        if (contextWindow !== undefined) descriptor.contextWindow = contextWindow;
        return descriptor;
      });
  }

  // --- introspectLoaded ----------------------------------------------------------------------

  /**
   * Each `/v1/models` entry self-reports `loaded: boolean` — no separate endpoint needed.
   * Reuses `listModels`'s parsing so the two never drift on field handling.
   */
  async introspectLoaded(
    server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const models = await this.listModels(server, cred, probe);
    return {
      loadedModelIds: models.filter((m) => m.loaded === true).map((m) => m.id),
      source: "introspection",
    };
  }

  // --- toPiModel ------------------------------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      // Local inference is free — cost is zero — but cache-hit token COUNTS still matter, so
      // streaming usage stays enabled (never fabricated) in case llama-server reports them.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: positiveSafeInteger(model.contextWindow) ?? FALLBACK_CONTEXT_WINDOW,
      maxTokens: positiveSafeInteger(model.maxTokens) ?? FALLBACK_MAX_TOKENS,
      compat: { supportsUsageInStreaming: true },
    };
  }

  // --- inferenceBaseUrl ------------------------------------------------------------------------

  inferenceBaseUrl(server: DiscoveredServer): string {
    const stripped = server.baseUrl.endsWith("/") ? server.baseUrl.slice(0, -1) : server.baseUrl;
    return stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const unslothAdapter: BackendAdapter = new UnslothAdapter();
