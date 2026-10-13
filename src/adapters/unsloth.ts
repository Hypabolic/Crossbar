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
 * # Vision detection (issue #35)
 *
 * The OpenAI-compatible `GET /v1/models` exposes NO modality information — entries carry only
 * `id`, `owned_by`, `quant`, context-length fields and `loaded`. Registering every model as
 * text-only (the old behaviour) made Pi silently replace attached images with the placeholder
 * `(image omitted: model does not support images)`, so VLMs appeared to "have no vision".
 *
 * Vision is read from the SAME loaded-backend status call used for thinking:
 * `GET /api/inference/status` reports `is_vision: boolean` for the resident model (verified
 * against a live instance: `is_vision: true` for a loaded Qwen3-VL). This is local and instant
 * — it never touches huggingface.co.
 *
 * We deliberately do NOT use `GET /api/models/check-vision/{model_name}`: for a model whose id
 * is not a resolvable HF repo (e.g. a local GGUF quant name like `Qwen3.8-27B-IQ4_NL`) Studio's
 * handler falls back to fetching `config.json` from huggingface.co and 401s in a retry loop on
 * EVERY `listModels`. Since Unsloth has no health endpoint Crossbar polls via `listModels`
 * every 15s → sustained HF noise/latency even for the loaded model. The status endpoint has no
 * such fallback.
 *
 * Vision is therefore known ONLY for the loaded model (its `active_model`). Unloaded models
 * stay text-only until they are loaded, when the next `listModels` picks up their real
 * modality. Best-effort: ANY failure (older Studio → 404, refused, malformed body) degrades
 * to text-only, the conservative pre-fix behaviour. Never throws, never blocks registration.
 *
 * # Thinking detection (issue #37)
 *
 * The model catalogue (`/v1/models`, `/api/models/*`) carries no thinking metadata at all.
 * Studio knows it only for the LOADED backend: `GET /api/inference/status` reports
 * `supports_reasoning`, `reasoning_style`, `reasoning_effort_levels` — plus `active_model`,
 * which carries the same public id as the `/v1/models` entry, so the flag can be matched to
 * exactly one model (verified against a live instance: `supports_reasoning: true` for a Qwen3
 * `enable_thinking` template). Unloaded models have no clean detection path and stay
 * `reasoning: false`. Same best-effort contract as vision: any probe failure degrades to the
 * conservative pre-fix behaviour and never throws.
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

/**
 * Shape of `GET /api/settings/openai-auto-switch` — the API surface of the
 * "Switch model by request" toggle (Settings ▸ API in the Studio UI). Only
 * `enabled` matters here; the rest of the body is ignored.
 */
interface UnslothAutoSwitchSettings {
  enabled?: unknown;
}

/**
 * Shape of `GET /api/inference/status` — the loaded-backend status surface. Only the fields
 * needed for vision and thinking detection are declared; everything else is ignored.
 */
interface UnslothInferenceStatus {
  /** Public id of the loaded model — same namespace as `/v1/models` entries. */
  active_model?: string;
  /** Whether the loaded model accepts image input. Trusted only when strictly `true`. */
  is_vision?: boolean;
  supports_reasoning?: boolean;
}

/** The literal header value Unsloth Studio sets on every response. */
const SERVER_HEADER_VALUE = "unsloth-studio";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unsloth Studio's documented default port (`UNSLOTH_STUDIO_URL` default). */
const DEFAULT_PORT = 8888;

/**
 * Settings endpoint backing the "Switch model by request" toggle. Discovered in the
 * Studio frontend bundle and verified against a live instance (2026-08-19):
 * `GET /api/settings/openai-auto-switch` → 200 `{ "enabled": false, ... }` with a
 * bearer key; the toggle's PUT writes the same object back.
 */
const AUTO_SWITCH_SETTINGS_PATH = "/api/settings/openai-auto-switch";

/**
 * Fallback context used ONLY at the Pi-mapping boundary, where the field is mandatory and a
 * model with no known context would otherwise be unusable. Matches the llama.cpp/llama-swap
 * adapters. `maxTokens: 0` means "no client-side cap — let the server decide".
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 0;

/** Loaded-backend status endpoint (thinking metadata; see the file header, issue #37). */
const INFERENCE_STATUS_PATH = "/api/inference/status";

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

/**
 * Read Studio's loaded-backend status: which model is resident (`active_model`), whether it
 * accepts image input (`is_vision`), and whether it supports thinking (`supports_reasoning`).
 *
 * The status endpoint describes the loaded backend only: `active_model` carries the same public
 * id as the `/v1/models` entry (verified against a live instance), so the caller can match it
 * exactly; when absent, the caller falls back to the `loaded: true` entry. Both vision and
 * thinking are known ONLY for the loaded model — unloaded models have no detection path
 * (issues #35, #37). Crucially this call never touches huggingface.co, unlike the per-model
 * `check-vision` probe (see file header).
 *
 * Best-effort by contract: any failure (older Studio versions without the endpoint → 404,
 * 401, refused connection, malformed body) yields `undefined` — vision and thinking stay off
 * everywhere, i.e. the conservative pre-fix behaviour. Never throws.
 */
async function loadedStatus(
  probe: Probe,
  headers: Record<string, string>,
): Promise<{ id?: string; vision: boolean; reasoning: boolean } | undefined> {
  try {
    const r = await probe(INFERENCE_STATUS_PATH, { headers });
    if (!r.ok || r.status !== 200) return undefined;
    const body = r.json as UnslothInferenceStatus | undefined;
    if (!body) return undefined;
    const result: { id?: string; vision: boolean; reasoning: boolean } = {
      vision: body.is_vision === true,
      reasoning: body.supports_reasoning === true,
    };
    if (typeof body.active_model === "string") result.id = body.active_model;
    return result;
  } catch {
    return undefined;
  }
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
    Capability.AutoLoadStatus,
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

    const entries = body.data.filter(
      (entry): entry is UnslothModelEntry => typeof entry?.id === "string",
    );

    // /v1/models carries no modality/thinking info. Both vision and thinking come from ONE
    // /api/inference/status call describing the loaded backend — which, unlike the per-model
    // check-vision probe, never touches HuggingFace (see file header). Known only for the
    // loaded model; unloaded models degrade to text-only / no-thinking. The helper is
    // internally defensive and never rejects.
    const status = await loadedStatus(probe, headers);

    // The status endpoint describes exactly one model. Match it by active_model id; fall back
    // to the `loaded: true` entry when it names nothing.
    const isLoadedTarget = (entry: UnslothModelEntry): boolean =>
      status === undefined
        ? false
        : status.id === undefined
          ? entry.loaded === true
          : entry.id === status.id;

    return entries.map((entry): ModelDescriptor => {
      const contextWindow = contextWindowFor(entry);
      const target = isLoadedTarget(entry);
      // Vision known only for the loaded model (issue #35); unloaded → text-only.
      const isVision = target && status?.vision === true;
      // Thinking metadata exists only for the loaded model (issue #37).
      const isReasoning = target && status?.reasoning === true;
      const descriptor: ModelDescriptor = {
        id: entry.id,
        name: entry.display_name ?? entry.id,
        input: isVision ? ["text", "image"] : ["text"],
        reasoning: isReasoning,
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

  // --- autoLoadsOnDemand ------------------------------------------------------------------------

  /**
   * Reads the "Switch model by request" setting (Settings ▸ API). When it is OFF, a request
   * naming an unloaded model 404s with a `model_not_found` error that points at exactly this
   * setting — so the picker must mark those models instead of letting the user pick one and
   * watch the first turn fail. When ON, unloaded models are loaded on demand and need no mark.
   *
   * Defensive by contract: a non-200 (old server versions without the endpoint 404), a
   * missing/malformed body, or a non-boolean `enabled` all yield `undefined` (unknown) —
   * the caller then shows the picker unmarked, i.e. today's behaviour.
   */
  async autoLoadsOnDemand(
    _server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<boolean | undefined> {
    const headers: Record<string, string> = {};
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["Authorization"] = `Bearer ${cred.apiKey}`;
    }

    const r = await probe(AUTO_SWITCH_SETTINGS_PATH, { headers });
    if (!r.ok || r.status !== 200) return undefined;

    const body = r.json as UnslothAutoSwitchSettings | undefined;
    return typeof body?.enabled === "boolean" ? body.enabled : undefined;
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
