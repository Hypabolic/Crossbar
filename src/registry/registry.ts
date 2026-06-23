/**
 * In-memory ServerRegistry — CRUD, health cache, and credential resolution.
 *
 * The registry is the single source of truth for server state at runtime.
 * It is constructed with injected dependencies (CredentialStore, persist fn, clock) so it
 * is fully testable without touching the filesystem or Pi runtime.
 *
 * Session wiring (session_start poll, session_shutdown cleanup) is Wave C and is NOT here.
 */

import type { CrossbarConfigFile, CrossbarSettings, HealthState, ModelDescriptor, ServerCredential, ServerRecord } from "../core/types.ts";
import type { CredentialStore } from "./persistence.ts";

export interface RegistryDeps {
  store: CredentialStore;
  /** Write the current state to disk. The registry calls this after every mutation. */
  persist: (config: CrossbarConfigFile) => Promise<void>;
  /** Clock injection for testability. Defaults to Date.now. */
  now?: () => number;
}

export interface HealthCachePatch {
  models?: ServerRecord["lastKnownModels"];
  loaded?: ServerRecord["lastKnownLoaded"];
  lastSeenAt?: number;
}

export class ServerRegistry {
  private readonly records: Map<string, ServerRecord> = new Map();
  /** Persisted discovery settings (LAN toggle, hosts, probe ports). */
  private settings: CrossbarSettings | undefined;
  /** Ephemeral, non-persisted health snapshot per server id (refreshed by the poll). */
  private readonly health: Map<string, HealthState> = new Map();
  private readonly store: CredentialStore;
  private readonly persist: (config: CrossbarConfigFile) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: RegistryDeps) {
    this.store = deps.store;
    this.persist = deps.persist;
    this.now = deps.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------------------
  // Initialisation — load records from a previously-read config file
  // ---------------------------------------------------------------------------

  /** Populate the in-memory registry from a loaded CrossbarConfigFile. */
  load(config: CrossbarConfigFile): void {
    this.records.clear();
    for (const record of config.servers) {
      this.records.set(record.id, record);
    }
    this.settings = config.settings;
  }

  // ---------------------------------------------------------------------------
  // Discovery settings (persisted alongside servers)
  // ---------------------------------------------------------------------------

  /** Current discovery settings, or undefined when none are configured. */
  getSettings(): CrossbarSettings | undefined {
    return this.settings;
  }

  /**
   * Replace the discovery settings and persist. An empty object is normalised to
   * `undefined` so crossbar.json stays clean when everything is at its default.
   */
  async setSettings(settings: CrossbarSettings): Promise<void> {
    this.settings = Object.keys(settings).length > 0 ? settings : undefined;
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Dismissed discovered servers (persisted; keyed by normalised base URL)
  // ---------------------------------------------------------------------------

  /** Normalise a base URL for dismiss comparisons (lowercase, no trailing slash). */
  private static normalizeUrl(baseUrl: string): string {
    return baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  }

  /** True when the given discovered base URL has been dismissed by the user. */
  isDismissed(baseUrl: string): boolean {
    const dismissed = this.settings?.dismissed;
    if (!dismissed || dismissed.length === 0) return false;
    return dismissed.includes(ServerRegistry.normalizeUrl(baseUrl));
  }

  /** Base URLs the user has dismissed from discovery. */
  dismissedList(): string[] {
    return this.settings?.dismissed ? [...this.settings.dismissed] : [];
  }

  /** Hide a discovered server from future scans until restored. */
  async dismiss(baseUrl: string): Promise<void> {
    const url = ServerRegistry.normalizeUrl(baseUrl);
    const current = this.settings?.dismissed ?? [];
    if (current.includes(url)) return;
    this.settings = { ...(this.settings ?? {}), dismissed: [...current, url] };
    await this.flush();
  }

  /** Restore a previously-dismissed server so it appears in scans again. */
  async undismiss(baseUrl: string): Promise<void> {
    const url = ServerRegistry.normalizeUrl(baseUrl);
    const current = this.settings?.dismissed ?? [];
    if (!current.includes(url)) return;
    const remaining = current.filter((u) => u !== url);
    const next: CrossbarSettings = { ...(this.settings ?? {}) };
    if (remaining.length > 0) next.dismissed = remaining;
    else delete next.dismissed;
    this.settings = Object.keys(next).length > 0 ? next : undefined;
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  list(): ServerRecord[] {
    return Array.from(this.records.values());
  }

  get(id: string): ServerRecord | undefined {
    return this.records.get(id);
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Add (or replace) a server record and optionally store its API key.
   * Persists after a successful write.
   */
  async add(record: ServerRecord, apiKey?: string): Promise<void> {
    this.records.set(record.id, record);
    if (apiKey !== undefined) {
      await this.store.set(record.id, apiKey);
    }
    await this.flush();
  }

  /**
   * Apply a partial patch to an existing record.
   * Throws if the id is not found.
   */
  async update(id: string, patch: Partial<Omit<ServerRecord, "id">>): Promise<void> {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`ServerRegistry: unknown id "${id}"`);
    this.records.set(id, { ...existing, ...patch });
    await this.flush();
  }

  /**
   * Remove a server record and its stored credential.
   * No-op (no throw) if the id is not found.
   */
  async remove(id: string): Promise<void> {
    if (!this.records.has(id)) return;
    this.records.delete(id);
    await this.store.remove(id);
    await this.flush();
  }

  /** Enable or disable a server without touching any other fields. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update(id, { enabled });
  }

  /**
   * Persistently update the cached model catalogue for a server.
   * Use this when the model list has materially changed and the new catalogue
   * must survive a process restart. Unlike updateHealthCache, this calls flush().
   * No-op if the id is unknown.
   */
  async setLastKnownModels(id: string, models: ModelDescriptor[]): Promise<void> {
    const existing = this.records.get(id);
    if (!existing) return;
    this.records.set(id, { ...existing, lastKnownModels: models });
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Health / model cache (non-persisting fast-path — called from the poll loop)
  // ---------------------------------------------------------------------------

  /**
   * Update the cached health snapshot for a server.
   * Does NOT persist — health cache is ephemeral, reconstructed on next poll.
   */
  updateHealthCache(id: string, patch: HealthCachePatch): void {
    const existing = this.records.get(id);
    if (!existing) return;
    const updated: ServerRecord = { ...existing };
    if (patch.models !== undefined) updated.lastKnownModels = patch.models;
    if (patch.loaded !== undefined) updated.lastKnownLoaded = patch.loaded;
    if (patch.lastSeenAt !== undefined) updated.lastSeenAt = patch.lastSeenAt;
    this.records.set(id, updated);
  }

  /** Record the latest health state for a server (ephemeral; drives the live widget). */
  setHealth(id: string, state: HealthState): void {
    this.health.set(id, state);
  }

  /** Last observed health state for a server, or undefined if not yet polled. */
  getHealth(id: string): HealthState | undefined {
    return this.health.get(id);
  }

  // ---------------------------------------------------------------------------
  // Credential resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the runtime credential for a server record.
   *   - mode "none" → { mode: "none" }
   *   - mode "apiKey" → fetch the key from the store; returns { mode: "apiKey", apiKey }
   *     (apiKey may be undefined if the key has not been stored yet)
   */
  async resolveCredential(record: ServerRecord): Promise<ServerCredential> {
    if (record.auth === "none") {
      return { mode: "none" };
    }
    const apiKey = await this.store.get(record.id);
    return { mode: "apiKey", ...(apiKey !== undefined ? { apiKey } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async flush(): Promise<void> {
    const config: CrossbarConfigFile = { version: 1, servers: this.list() };
    // Preserve discovery settings across every mutation — otherwise any server
    // add/remove/toggle would drop a user's LAN/probe-port configuration.
    if (this.settings && Object.keys(this.settings).length > 0) {
      config.settings = this.settings;
    }
    await this.persist(config);
  }
}
