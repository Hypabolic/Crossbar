/**
 * The `BackendAdapter` contract — Crossbar's single most important interface and the FROZEN boundary
 * every backend implementation codes against. Phase 2 fan-out (one adapter per backend) targets this
 * file and nothing else; the conformance suite (tests/conformance) validates every adapter against it.
 *
 * Design tenets:
 *  - Adapters are STATELESS. All state (selected server, credentials, last-known models) is owned by
 *    the registry and passed in. An adapter instance is a singleton describing one backend *kind*.
 *  - Adapters perform NO direct I/O. Every network call goes through the injected {@link Probe}, so the
 *    same adapter runs unchanged in production, in discovery, and against test fixtures.
 *  - Capabilities are HONEST. An optional method is present iff the matching {@link Capability} is in
 *    `capabilities`. The orchestrator checks the set, never feature-sniffs the method.
 *  - Pi mapping is OWNED by the adapter. `toPiModel` / `inferenceBaseUrl` are the only places that know
 *    which built-in Pi API type and compat flags a backend needs; the shim stays generic.
 *
 * See ARCHITECTURE.md for how the registry, discovery engine, and provider shim consume this.
 */

import type { Capability, BackendKind } from "./capability.ts";
import type {
  DiscoveredServer,
  HealthStatus,
  LoadAction,
  LoadedState,
  ModelDescriptor,
  PiModelEntry,
  Probe,
  ServerCredential,
} from "./types.ts";

/** Bumped on any breaking change to this interface. Adapters and the registry assert on it. */
export const CONTRACT_VERSION = 1 as const;

/** Which built-in Pi API type the adapter registers its models under. */
export type PiApiType = "openai-completions" | "anthropic-messages";

export interface BackendAdapter {
  /** Stable identity. One adapter instance per kind. */
  readonly kind: BackendKind;
  /** Human-facing name, e.g. "LM Studio". */
  readonly displayName: string;
  /** Ports the discovery engine probes for this backend (empty for cloud kinds). */
  readonly defaultPorts: readonly number[];
  /** The Pi built-in API type all this backend's models register under. */
  readonly piApi: PiApiType;
  /** The capabilities this backend exposes. Drives UX and which optional methods are present. */
  readonly capabilities: ReadonlySet<Capability>;

  /**
   * Decide whether `baseUrl` is *this* backend. MUST use only unauthenticated metadata endpoints
   * (most local servers leave `/v1/models`, `/health`, `/props` public even when keyed). Return a
   * {@link DiscoveredServer} with a confidence score, or `null` if this isn't our backend.
   * Cloud adapters return `null` (they are configured, not probed).
   */
  fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null>;

  /** Liveness / readiness. Present iff `capabilities` has {@link Capability.Health}. */
  health?(server: DiscoveredServer, cred: ServerCredential, probe: Probe): Promise<HealthStatus>;

  /** Enumerate available models. Required (every backend supports {@link Capability.ListModels}). */
  listModels(server: DiscoveredServer, cred: ServerCredential, probe: Probe): Promise<ModelDescriptor[]>;

  /** Snapshot of currently-loaded models. Present iff {@link Capability.IntrospectLoaded}. */
  introspectLoaded?(
    server: DiscoveredServer,
    cred: ServerCredential,
    probe: Probe,
  ): Promise<LoadedState>;

  /**
   * Make `modelId` the active/served model. Present iff {@link Capability.SwitchModel}. Implementations
   * range from a no-op + implicit load (Ollama) to a proxy swap that restarts an upstream (llama-swap).
   * MUST reject if the switch cannot be confirmed (server down mid-switch, model not available).
   */
  switchModel?(
    server: DiscoveredServer,
    cred: ServerCredential,
    modelId: string,
    probe: Probe,
  ): Promise<void>;

  /** Explicit load/unload. Present iff {@link Capability.LoadUnload}. */
  loadUnload?(
    server: DiscoveredServer,
    cred: ServerCredential,
    modelId: string,
    action: LoadAction,
    probe: Probe,
  ): Promise<void>;

  /**
   * Map one discovered model to the exact entry Pi's `registerProvider` expects. Owns api/compat-flag
   * selection, cost zeros for local backends, and conservative defaults when caps are unknown.
   */
  toPiModel(server: DiscoveredServer, model: ModelDescriptor): PiModelEntry;

  /**
   * The base URL Pi should use for *inference* against this server. May differ from
   * `server.baseUrl` (e.g. append `/v1` for OpenAI-compat backends, or point at the proxy front door).
   */
  inferenceBaseUrl(server: DiscoveredServer): string;
}

/** Narrowing helpers so the orchestrator never calls an absent optional method. */
export const supports = (a: BackendAdapter, c: Capability): boolean => a.capabilities.has(c);

export function canSwitch(
  a: BackendAdapter,
): a is BackendAdapter & Required<Pick<BackendAdapter, "switchModel">> {
  return typeof a.switchModel === "function";
}

export function canIntrospect(
  a: BackendAdapter,
): a is BackendAdapter & Required<Pick<BackendAdapter, "introspectLoaded">> {
  return typeof a.introspectLoaded === "function";
}

export function canLoadUnload(
  a: BackendAdapter,
): a is BackendAdapter & Required<Pick<BackendAdapter, "loadUnload">> {
  return typeof a.loadUnload === "function";
}
