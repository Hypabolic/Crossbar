/**
 * Anthropic cloud backend adapter for Crossbar.
 *
 * Anthropic is a CLOUD backend: configured by the user, never port-probed. Hence:
 *   - `fingerprint(...)` ALWAYS returns null (cloud adapters are not discovered).
 *   - capabilities: ListModels + PerModelCaps + Streaming.
 *
 * AUTH: unlike OpenAI, Anthropic does NOT use a Bearer token. It requires
 *   - `x-api-key: <key>`
 *   - `anthropic-version: 2023-06-01`
 * We set these explicitly on the probe `init.headers` from `cred.apiKey`. The key
 * is only ever placed into the request header — it is NEVER logged or serialized.
 *
 * listModels: GET /v1/models → data[] carries per-model caps
 *   ({ id, display_name, max_input_tokens, max_tokens, capabilities{...} }), so
 *   we read them directly and only fall back to a static table when missing.
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
// API response shape
// ---------------------------------------------------------------------------

interface AnthropicModelRow {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: {
    image_input?: boolean;
    thinking?: boolean;
    [k: string]: unknown;
  };
}

interface AnthropicModelsResponse {
  data?: AnthropicModelRow[];
}

// ---------------------------------------------------------------------------
// Constants & static fallback table
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;

/** Static fallback caps keyed by an id-prefix matcher, used when the API row
 *  omits a field (e.g. max_input_tokens 0/missing). First match wins. */
interface StaticRule {
  match: (id: string) => boolean;
  contextWindow: number;
  maxTokens: number;
}

const STATIC_TABLE: StaticRule[] = [
  { match: (id) => id.startsWith("claude-opus-4"), contextWindow: 200_000, maxTokens: 32_000 },
  { match: (id) => id.startsWith("claude-sonnet-4"), contextWindow: 200_000, maxTokens: 64_000 },
  { match: (id) => id.startsWith("claude-3-7-sonnet"), contextWindow: 200_000, maxTokens: 64_000 },
  { match: (id) => id.startsWith("claude-3-5-sonnet"), contextWindow: 200_000, maxTokens: 8192 },
  { match: (id) => id.startsWith("claude-3-5-haiku"), contextWindow: 200_000, maxTokens: 8192 },
  { match: (id) => id.startsWith("claude-3-opus"), contextWindow: 200_000, maxTokens: 4096 },
  { match: (id) => id.startsWith("claude-3-haiku"), contextWindow: 200_000, maxTokens: 4096 },
];

function staticFallback(id: string): { contextWindow: number; maxTokens: number } {
  const lower = id.toLowerCase();
  for (const rule of STATIC_TABLE) {
    if (rule.match(lower)) return { contextWindow: rule.contextWindow, maxTokens: rule.maxTokens };
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS };
}

// ---------------------------------------------------------------------------
// AnthropicAdapter
// ---------------------------------------------------------------------------

class AnthropicAdapter implements BackendAdapter {
  readonly kind = "anthropic" as const;
  readonly displayName = "Anthropic";
  readonly defaultPorts: readonly number[] = [];
  readonly piApi: PiApiType = "anthropic-messages";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
    Capability.PerModelCaps,
    Capability.Streaming,
  ]);

  // --- fingerprint ----------------------------------------------------------

  /** Cloud backend: configured, never probed. Always null. */
  async fingerprint(_baseUrl: string, _probe: Probe): Promise<DiscoveredServer | null> {
    return null;
  }

  // --- listModels -----------------------------------------------------------

  async listModels(
    _server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    const r = await probe("/v1/models", {
      method: "GET",
      headers: this._authHeaders(cred),
    });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    const body = r.json as AnthropicModelsResponse | undefined;
    const rows = body?.data ?? [];

    return rows
      .filter((m) => typeof m.id === "string" && m.id.length > 0)
      .map((m) => this._describe(m));
  }

  /**
   * Build Anthropic auth headers from the credential. The API key is placed only
   * into the `x-api-key` header — never logged or serialized anywhere.
   */
  private _authHeaders(cred: ServerCredential): Record<string, string> {
    const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
    if (cred.mode === "apiKey" && cred.apiKey) {
      headers["x-api-key"] = cred.apiKey;
    }
    return headers;
  }

  /** Map one API row → ModelDescriptor, reading caps with static fallback. */
  private _describe(m: AnthropicModelRow): ModelDescriptor {
    const fallback = staticFallback(m.id);
    const contextWindow =
      typeof m.max_input_tokens === "number" && m.max_input_tokens > 0
        ? m.max_input_tokens
        : fallback.contextWindow;
    const maxTokens =
      typeof m.max_tokens === "number" && m.max_tokens > 0 ? m.max_tokens : fallback.maxTokens;
    const hasImage = m.capabilities?.image_input === true;
    const hasThinking = m.capabilities?.thinking === true;

    return {
      id: m.id,
      name: m.display_name && m.display_name.length > 0 ? m.display_name : m.id,
      contextWindow,
      maxTokens,
      input: hasImage ? ["text", "image"] : ["text"],
      reasoning: hasThinking,
      tools: true,
      embeddings: false,
      raw: m,
    };
  }

  // --- toPiModel ------------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
      // Crossbar does not bill — costs are always zero.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  // --- inferenceBaseUrl -----------------------------------------------------

  inferenceBaseUrl(server: DiscoveredServer): string {
    return server.baseUrl || DEFAULT_BASE_URL;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const anthropicAdapter: BackendAdapter = new AnthropicAdapter();
