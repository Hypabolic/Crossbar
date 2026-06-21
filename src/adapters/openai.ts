/**
 * OpenAI cloud backend adapter for Crossbar.
 *
 * OpenAI is a CLOUD backend: it is configured by the user (base URL + API key),
 * never port-probed. Therefore:
 *   - `fingerprint(...)` ALWAYS returns null (cloud adapters are not discovered).
 *   - capabilities are limited to ListModels + Streaming (no Health, no
 *     IntrospectLoaded/SwitchModel/LoadUnload, no PerModelCaps — the OpenAI API
 *     exposes no per-model capability metadata).
 *
 * listModels: GET /v1/models with a Bearer token. The orchestrator's injected
 * Probe attaches the Authorization header automatically for apiKey servers, so
 * this adapter never touches (or logs) the key itself. The API returns only bare
 * ids, so per-model caps are enriched from a STATIC table of known families.
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

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Constants & static capability table
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Conservative defaults for ids not matched by the static table. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4096;

/** Static per-family caps, keyed by an id-prefix matcher. First match wins. */
interface StaticCaps {
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
}

interface StaticRule {
  /** Returns true if this rule applies to the given (lower-cased) model id. */
  match: (id: string) => boolean;
  caps: StaticCaps;
}

const STATIC_TABLE: StaticRule[] = [
  // Reasoning models (o-series). No vision on the bare reasoning ids.
  {
    match: (id) => id.startsWith("o3") || id.startsWith("o4-mini") || id.startsWith("o1"),
    caps: { contextWindow: 200_000, maxTokens: 100_000, input: ["text"], reasoning: true },
  },
  // GPT-4.1 family — 1M context.
  {
    match: (id) => id.startsWith("gpt-4.1"),
    caps: { contextWindow: 1_000_000, maxTokens: 32_768, input: ["text", "image"], reasoning: false },
  },
  // GPT-4o family (multimodal, 128k).
  {
    match: (id) => id.startsWith("gpt-4o"),
    caps: { contextWindow: 128_000, maxTokens: 16_384, input: ["text", "image"], reasoning: false },
  },
  // Legacy GPT-4 Turbo (128k, vision).
  {
    match: (id) => id.startsWith("gpt-4-turbo") || id.startsWith("gpt-4-1106") || id.startsWith("gpt-4-0125"),
    caps: { contextWindow: 128_000, maxTokens: 4096, input: ["text", "image"], reasoning: false },
  },
  // Original GPT-4 (8k).
  {
    match: (id) => id.startsWith("gpt-4"),
    caps: { contextWindow: 8192, maxTokens: 4096, input: ["text"], reasoning: false },
  },
  // GPT-3.5 Turbo (16k).
  {
    match: (id) => id.startsWith("gpt-3.5"),
    caps: { contextWindow: 16_385, maxTokens: 4096, input: ["text"], reasoning: false },
  },
];

/** Look up static caps for an id, falling back to conservative defaults. */
function lookupCaps(id: string): StaticCaps {
  const lower = id.toLowerCase();
  for (const rule of STATIC_TABLE) {
    if (rule.match(lower)) return rule.caps;
  }
  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    input: ["text"],
    reasoning: false,
  };
}

// ---------------------------------------------------------------------------
// OpenAiAdapter
// ---------------------------------------------------------------------------

class OpenAiAdapter implements BackendAdapter {
  readonly kind = "openai" as const;
  readonly displayName = "OpenAI";
  readonly defaultPorts: readonly number[] = [];
  readonly piApi: PiApiType = "openai-completions";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    Capability.ListModels,
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
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<ModelDescriptor[]> {
    // The injected Probe adds `Authorization: Bearer <key>` automatically for
    // apiKey servers, so we never read or log cred.apiKey here.
    const r = await probe("/v1/models", { method: "GET" });
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("server unreachable (status:0)");
      throw new Error(`listModels failed: status ${r.status}`);
    }

    const body = r.json as OpenAiModelsResponse | undefined;
    const rows = body?.data ?? [];

    return rows
      .filter((m) => typeof m.id === "string" && m.id.length > 0)
      .map((m) => this._describe(m.id));
  }

  /** Build a ModelDescriptor from a bare id + static caps. */
  private _describe(id: string): ModelDescriptor {
    const isEmbedding = id.toLowerCase().startsWith("text-embedding");
    const caps = lookupCaps(id);
    return {
      id,
      name: id,
      contextWindow: caps.contextWindow,
      maxTokens: caps.maxTokens,
      input: caps.input,
      reasoning: caps.reasoning,
      tools: !isEmbedding,
      embeddings: isEmbedding,
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

export const openaiAdapter: BackendAdapter = new OpenAiAdapter();
