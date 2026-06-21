/**
 * LM Studio backend adapter.
 *
 * Implements the BackendAdapter contract for LM Studio's local server.
 * Uses the LM Studio-native /api/v0/* endpoints for discovery and management,
 * and delegates inference to the OpenAI-compatible /v1/* layer.
 *
 * Key API endpoints:
 *   GET  /api/v0/models            — model list with state, type, context lengths
 *   POST /api/v1/models/load       — load a model by id
 *   POST /api/v1/models/unload     — unload a model by id
 *
 * Fingerprint discriminator: data[] entries have both `state` and
 * `compatibility_type` fields (unique to LM Studio's v0 API).
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
// LM Studio API shapes (narrowed from unknown JSON)
// ---------------------------------------------------------------------------

interface LmsModelEntry {
  id: string;
  type?: string;                    // "llm" | "vlm" | "embeddings"
  state?: string;                   // "loaded" | "not-loaded"
  max_context_length?: number;
  loaded_context_length?: number;
  quantization?: string;
  arch?: string;
}

interface LmsModelsResponse {
  data?: LmsModelEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow an unknown JSON body to a LmsModelsResponse defensively. */
function parseModelsBody(json: unknown): LmsModelsResponse {
  if (json == null || typeof json !== "object") return {};
  const obj = json as Record<string, unknown>;
  const data = obj["data"];
  if (!Array.isArray(data)) return {};
  const entries: LmsModelEntry[] = [];
  for (const item of data) {
    if (item == null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const entry: LmsModelEntry = {
      id: typeof m["id"] === "string" ? m["id"] : String(m["id"] ?? ""),
    };
    if (typeof m["type"] === "string") entry.type = m["type"];
    if (typeof m["state"] === "string") entry.state = m["state"];
    if (typeof m["max_context_length"] === "number") entry.max_context_length = m["max_context_length"];
    if (typeof m["loaded_context_length"] === "number") entry.loaded_context_length = m["loaded_context_length"];
    if (typeof m["quantization"] === "string") entry.quantization = m["quantization"];
    if (typeof m["arch"] === "string") entry.arch = m["arch"];
    entries.push(entry);
  }
  return { data: entries };
}

/**
 * Check that a parsed models response has the LM Studio discriminator:
 * at least one entry with both `state` and `compatibility_type` (or we check
 * `state` as the unique discriminator since compatibility_type is what the
 * SPEC calls out; we check state on the actual fields we parse).
 *
 * The SPEC says: data[] entries have `state` and `compatibility_type`.
 * We check for `state` field presence (which is definitively LM Studio).
 */
function hasLmsDiscriminator(json: unknown): boolean {
  if (json == null || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;
  const data = obj["data"];
  if (!Array.isArray(data) || data.length === 0) return false;
  // Check that at least one entry has `state` (and optionally `compatibility_type`)
  // The raw json (before parsing) has the original fields, so we check there
  for (const item of data) {
    if (item == null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if ("state" in m && "compatibility_type" in m) return true;
    // Some versions may only have state — still a strong signal
    if ("state" in m) return true;
  }
  return false;
}

/** Map a LM Studio model entry to a Crossbar ModelDescriptor. */
function toDescriptor(m: LmsModelEntry): ModelDescriptor {
  const isEmbeddings = m.type === "embeddings";
  const isVlm = m.type === "vlm";

  const input: ("text" | "image")[] = ["text"];
  if (isVlm) input.push("image");

  const desc: ModelDescriptor = {
    id: m.id,
    name: m.id,
    input,
    embeddings: isEmbeddings,
    loaded: m.state === "loaded",
    raw: m,
  };
  if (m.max_context_length !== undefined) {
    desc.contextWindow = m.max_context_length;
  }
  return desc;
}

// ---------------------------------------------------------------------------
// LmStudioAdapter
// ---------------------------------------------------------------------------

class LmStudioAdapter implements BackendAdapter {
  readonly kind = "lmstudio" as const;
  readonly displayName = "LM Studio";
  readonly defaultPorts: readonly number[] = [1234];
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
    const r = await probe("/api/v0/models");
    if (!r.ok || r.status === 0) return null;
    if (!hasLmsDiscriminator(r.json)) return null;

    return {
      kind: "lmstudio",
      baseUrl,
      auth: "none",
      label: `LM Studio (${baseUrl.replace(/^https?:\/\//, "")})`,
      confidence: 0.95,
    };
  }

  // --- health ---------------------------------------------------------------

  async health(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<HealthStatus> {
    const r = await probe("/api/v0/models");
    if (r.status === 0) return { state: "unreachable" };
    if (r.status === 401) return { state: "unauthorized" };
    if (!r.ok) return { state: "degraded" };
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
    const r = await probe("/api/v0/models");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("listModels failed: server unreachable");
      throw new Error(`listModels failed: status ${r.status}`);
    }
    const body = parseModelsBody(r.json);
    if (!body.data) return [];
    return body.data.map(toDescriptor);
  }

  // --- introspectLoaded -----------------------------------------------------

  async introspectLoaded(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState> {
    const r = await probe("/api/v0/models");
    if (!r.ok) {
      if (r.status === 401) throw new Error("401 Unauthorized");
      if (r.status === 0) throw new Error("introspectLoaded failed: server unreachable");
      throw new Error(`introspectLoaded failed: status ${r.status}`);
    }
    const body = parseModelsBody(r.json);
    const loaded = (body.data ?? []).filter((m) => m.state === "loaded");
    const perModel: Record<string, { contextLength: number }> = {};
    for (const m of loaded) {
      if (m.loaded_context_length !== undefined) {
        perModel[m.id] = { contextLength: m.loaded_context_length };
      }
    }
    const result: LoadedState = {
      loadedModelIds: loaded.map((m) => m.id),
      source: "introspection",
    };
    if (Object.keys(perModel).length > 0) {
      result.perModel = perModel;
    }
    return result;
  }

  // --- switchModel ----------------------------------------------------------

  async switchModel(
    _server: DiscoveredServer,
    _cred: ServerCredential,
    modelId: string,
    probe: Probe,
  ): Promise<void> {
    // Step 1: JIT load
    const r1 = await probe("/api/v1/models/load", {
      method: "POST",
      body: JSON.stringify({ model: modelId }),
      headers: { "content-type": "application/json" },
    });
    if (!r1.ok) {
      if (r1.status === 0) throw new Error("switchModel failed: server unreachable");
      if (r1.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`switchModel load failed: status ${r1.status}`);
    }

    // Step 2: Confirm via model list that the target is now loaded
    const r2 = await probe("/api/v0/models");
    if (!r2.ok) {
      if (r2.status === 0) throw new Error("switchModel confirmation failed: server went down");
      if (r2.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`switchModel confirmation failed: status ${r2.status}`);
    }
    const body = parseModelsBody(r2.json);
    const found = (body.data ?? []).find((m) => m.id === modelId);
    if (!found || found.state !== "loaded") {
      throw new Error(`model-not-loaded: ${modelId} not found in loaded state after switch`);
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
    const path = action === "load"
      ? "/api/v1/models/load"
      : "/api/v1/models/unload";
    const r = await probe(path, {
      method: "POST",
      body: JSON.stringify({ model: modelId }),
      headers: { "content-type": "application/json" },
    });
    if (!r.ok) {
      if (r.status === 0) throw new Error(`loadUnload(${action}) failed: server unreachable`);
      if (r.status === 401) throw new Error("401 Unauthorized");
      throw new Error(`loadUnload(${action}) failed: status ${r.status}`);
    }
  }

  // --- toPiModel ------------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? (model.input as ("text" | "image")[]) : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 8192,
      maxTokens: model.maxTokens ?? 4096,
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

export const lmstudioAdapter: BackendAdapter = new LmStudioAdapter();
