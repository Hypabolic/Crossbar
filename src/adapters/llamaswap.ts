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
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  ]);

  // --- fingerprint ----------------------------------------------------------

  async fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null> {
    // /running is a llama-swap-only path — not present on bare llama-server.
    const r = await probe("/running");
    if (!r.ok) return null;
    // Must parse as JSON (llama-swap returns JSON from /running, not plain text)
    if (r.json === undefined && r.text !== undefined) {
      // If text is not JSON, bail
      try {
        JSON.parse(r.text);
      } catch {
        return null;
      }
    }
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
    const body = r.json as V1ModelsBody | undefined;
    const data = body?.data ?? [];
    return data.map((entry) => ({
      id: entry.id,
      name: entry.id,
      contextWindow: 8192,
      maxTokens: 4096,
      input: ["text"] as ("text" | "image")[],
      reasoning: false,
    }));
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

  // --- toPiModel ------------------------------------------------------------

  toPiModel(_server: DiscoveredServer, model: ModelDescriptor): PiModelEntry {
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input.length > 0 ? model.input : ["text"],
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

export const llamaswapAdapter: BackendAdapter = new LlamaswapAdapter();
