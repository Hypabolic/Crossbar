/**
 * Crossbar core data shapes — the values that flow between discovery, the registry, adapters, and the
 * Pi provider-registration shim. Locked Phase 1 contract. See ARCHITECTURE.md.
 *
 * The single hard tie to Pi is {@link PiModelEntry}: it is derived from Pi's exported `ProviderConfig`
 * so the shim cannot drift from the real `pi.registerProvider` schema.
 */

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { AuthMode, BackendKind } from "./capability.ts";

/** A single model entry exactly as Pi's `registerProvider` expects it. Derived from the real type. */
export type PiModelEntry = NonNullable<ProviderConfig["models"]>[number];

// ---------------------------------------------------------------------------------------------------
// Probing primitive (injected, not imported) — keeps adapters testable and side-effect free.
// ---------------------------------------------------------------------------------------------------

export interface ProbeInit {
  method?: "GET" | "POST" | "HEAD";
  /** Header map. The orchestrator injects auth headers; adapters add content-type etc. as needed. */
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout. Discovery uses a short budget (default supplied by the engine). */
  timeoutMs?: number;
}

export interface ProbeResult {
  /** HTTP status, or 0 when the request never completed (connection refused / timeout). */
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Present when the body was read as text. */
  text?: string;
  /** Present when the body parsed as JSON. Adapters should narrow defensively. */
  json?: unknown;
  /** Round-trip latency in ms, when measured. */
  latencyMs?: number;
  /** Set when the request failed before a response (refused, DNS, timeout). */
  error?: string;
}

/**
 * The injected fetch primitive. `path` is resolved against the server base URL by the caller-provided
 * implementation. Adapters MUST go through this rather than calling `fetch` directly so that timeouts,
 * auth-header injection, redaction, and test fakes all live in one place.
 */
export type Probe = (path: string, init?: ProbeInit) => Promise<ProbeResult>;

// ---------------------------------------------------------------------------------------------------
// Credentials — secrets are resolved at call time; they are NEVER persisted to crossbar.json and NEVER
// logged. Persistence of the key itself goes through Pi's authStorage (auth.json, 0600).
// ---------------------------------------------------------------------------------------------------

export interface ServerCredential {
  mode: AuthMode;
  /** Resolved secret, present only when mode === "apiKey". Treat as sensitive; never log or serialize. */
  apiKey?: string;
}

// ---------------------------------------------------------------------------------------------------
// Discovery & health
// ---------------------------------------------------------------------------------------------------

export interface DiscoveredServer {
  kind: BackendKind;
  /** Normalized origin used for fingerprinting & metadata calls (no trailing slash, no `/v1`). */
  baseUrl: string;
  auth: AuthMode;
  version?: string;
  /** Human label, e.g. "Ollama (127.0.0.1:11434)". */
  label: string;
  /** Fingerprint confidence 0..1; the engine prefers the highest-confidence match per origin. */
  confidence: number;
}

export type HealthState = "healthy" | "loading" | "degraded" | "unauthorized" | "unreachable";

export interface HealthStatus {
  state: HealthState;
  detail?: string;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------------------------------
// Models & loaded state
// ---------------------------------------------------------------------------------------------------

export interface ModelDescriptor {
  id: string;
  name: string;
  /** Context window in tokens, when the backend reports it. */
  contextWindow?: number;
  /** Max output tokens, when known. */
  maxTokens?: number;
  /** Input modalities. Defaults to ["text"] when the backend doesn't say. */
  input: ("text" | "image")[];
  /** Supports extended thinking / reasoning. */
  reasoning?: boolean;
  /** Supports tool/function calling. */
  tools?: boolean;
  /** Is an embeddings model (excluded from chat model registration). */
  embeddings?: boolean;
  /** Best-effort: was this model resident at list time (from introspection)? */
  loaded?: boolean;
  /** Original backend payload, retained for diagnostics. Never registered with Pi. */
  raw?: unknown;
}

export interface LoadedModelInfo {
  vramBytes?: number;
  /** Unix ms when the model will be evicted (Ollama keep_alive, LM Studio TTL). */
  expiresAt?: number;
  /** Runtime context length if it differs from the model's max. */
  contextLength?: number;
}

export interface LoadedState {
  loadedModelIds: string[];
  perModel?: Record<string, LoadedModelInfo>;
  /** How this snapshot was obtained — drives whether the widget shows a live or last-known indicator. */
  source: "introspection" | "last-known" | "unknown";
}

export type LoadAction = "load" | "unload";

// ---------------------------------------------------------------------------------------------------
// Persistence — crossbar.json (non-secret) lives at getAgentDir()/crossbar.json. Secrets are in auth.json.
// ---------------------------------------------------------------------------------------------------

export interface ServerRecord {
  /** Stable Crossbar id. Doubles as the Pi provider name AND the auth.json key for this server. */
  id: string;
  kind: BackendKind;
  /** Normalized origin (same shape as DiscoveredServer.baseUrl). */
  baseUrl: string;
  label: string;
  auth: AuthMode;
  enabled: boolean;
  /** Unix ms. */
  addedAt: number;
  lastSeenAt?: number;
  /** Cached for offline rendering / fast startup; refreshed on health poll. */
  lastKnownModels?: ModelDescriptor[];
  /** Cached loaded-model ids for the "currently loaded" widget when introspection is unavailable. */
  lastKnownLoaded?: string[];
}

export interface CrossbarSettings {
  /** Opt-in LAN host-range probing (default false — localhost only). */
  lanDiscovery?: boolean;
  /**
   * Explicit hosts (IPs or hostnames) to probe when `lanDiscovery` is enabled.
   * There is no mDNS for these backends, so the host list must be supplied here.
   * Each host is probed across {@link probePorts} (or the defaults).
   */
  lanHosts?: string[];
  /** Override the default localhost probe ports. */
  probePorts?: number[];
}

export interface CrossbarConfigFile {
  version: 1;
  servers: ServerRecord[];
  settings?: CrossbarSettings;
}
