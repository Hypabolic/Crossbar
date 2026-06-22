/**
 * Provider-registration shim — the ONLY place Crossbar calls Pi's
 * `pi.registerProvider` / `pi.unregisterProvider`.
 *
 * # API-key handoff decision
 *
 * Pi requires a truthy `apiKey` when registering models and also rejects a
 * request before sending it when the configured value resolves to undefined.
 * Therefore an unset `$ENV` reference is not a valid representation of a
 * keyless local server.
 *
 * Pi documents this explicitly for local models: the API key is required by Pi,
 * but local OpenAI-compatible servers ignore it, so any value works.
 *
 * - Keyed server: use the `$ENV` sentinel. Pi reads the real key from auth.json
 *   first, so no plaintext secret is stored in ProviderConfig.
 * - No-auth server: use a fixed, non-secret placeholder. This passes both Pi's
 *   registration and request-time auth checks.
 */

import type { ProviderConfig, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerRecord, DiscoveredServer, ModelDescriptor } from "../core/types.ts";
import { adapterFor } from "../adapters/index.ts";
import { envVarFor } from "../registry/ids.ts";
import type { ServerRegistry } from "../registry/registry.ts";

const NO_AUTH_API_KEY = "crossbar-no-auth";

// ---------------------------------------------------------------------------
// buildProviderConfig — pure mapping, no I/O
// ---------------------------------------------------------------------------

/**
 * Build the ProviderConfig that should be handed to `pi.registerProvider(record.id, config)`.
 *
 * PURE — no I/O, no side effects. Only call this after the model cache is populated.
 *
 * @param record  - Persistent server record (id, kind, label, auth, …).
 * @param server  - Discovered-server snapshot (baseUrl, auth, …).
 * @param models  - Full model list as returned by `adapter.listModels`; embedding models
 *                  are filtered out here and never registered with Pi.
 */
export function buildProviderConfig(
  record: ServerRecord,
  server: DiscoveredServer,
  models: ModelDescriptor[],
): ProviderConfig {
  const adapter = adapterFor(record.kind);

  // Filter out embedding-only models — Pi registers these as chat models which
  // is incorrect.  Non-embedding models are the ones Pi cares about.
  const chatModels = models.filter((m) => !m.embeddings);

  // Map each chat model through the adapter's owned toPiModel logic.
  const piModels: ProviderConfig["models"] = chatModels.map((m) =>
    adapter.toPiModel(server, m),
  );

  // Pi requires a resolved API key before it will send any request, including
  // requests to keyless local servers. The placeholder is intentionally not a
  // secret; local servers ignore it. Keyed servers still resolve their real
  // credential from auth.json via the provider id.
  const apiKey =
    record.auth === "none"
      ? NO_AUTH_API_KEY
      : "$" + envVarFor(record.id);

  const config: ProviderConfig = {
    name: record.label,
    baseUrl: adapter.inferenceBaseUrl(server),
    api: adapter.piApi,
    apiKey,
    models: piModels,
  };

  return config;
}

// ---------------------------------------------------------------------------
// registerCachedServer — factory-phase preload, no network, no registry
// ---------------------------------------------------------------------------

/**
 * Register a server with Pi using only cached models. Used during the extension
 * factory to preload known providers before Pi resolves model scopes.
 *
 * Filters to chat models only; returns false without registering when none remain.
 * Never performs network requests, credential writes, or registry operations.
 */
export function registerCachedServer(
  pi: ExtensionAPI,
  record: ServerRecord,
  models: ModelDescriptor[],
): boolean {
  const chatModels = models.filter((m) => !m.embeddings);
  if (chatModels.length === 0) return false;

  const server: DiscoveredServer = {
    kind: record.kind,
    baseUrl: record.baseUrl,
    auth: record.auth,
    label: record.label,
    confidence: 1,
  };

  const config = buildProviderConfig(record, server, chatModels);
  pi.registerProvider(record.id, config);
  return true;
}

// ---------------------------------------------------------------------------
// registerServer
// ---------------------------------------------------------------------------

/**
 * Build the server's ProviderConfig and register it with Pi. Idempotent — Pi's
 * `registerProvider` replaces an existing registration.
 */
export async function registerServer(
  pi: ExtensionAPI,
  registry: ServerRegistry,
  record: ServerRecord,
  models: ModelDescriptor[],
): Promise<void> {
  if (record.auth === "apiKey") {
    const credential = await registry.resolveCredential(record);
    if (credential.apiKey === undefined) {
      throw new Error(`API key missing for ${record.label}; add it again through /crossbar`);
    }
  }

  // Retrieve the DiscoveredServer shape from the record.
  // The registry stores the canonicalised baseUrl; reconstruct a minimal server
  // descriptor for the adapter calls (only baseUrl and kind are needed here).
  const server: DiscoveredServer = {
    kind: record.kind,
    baseUrl: record.baseUrl,
    auth: record.auth,
    label: record.label,
    confidence: 1,
  };

  const config = buildProviderConfig(record, server, models);
  pi.registerProvider(record.id, config);
}

// ---------------------------------------------------------------------------
// unregisterServer
// ---------------------------------------------------------------------------

/**
 * Remove this server's Pi provider registration.
 * Pi restores any built-in models that were overridden.
 */
export function unregisterServer(pi: ExtensionAPI, record: ServerRecord): void {
  pi.unregisterProvider(record.id);
}

// ---------------------------------------------------------------------------
// reRegisterServer
// ---------------------------------------------------------------------------

/**
 * Re-register a server after its model list has changed.
 *
 * Pi's `registerProvider` with `models` replaces the existing model list, so
 * a plain call to `registerServer` would suffice — but the ARCHITECTURE.md
 * contract specifies explicit unregister-then-register to guarantee a clean
 * replacement (removes stale models, resets compat flags, etc.).
 */
export async function reRegisterServer(
  pi: ExtensionAPI,
  registry: ServerRegistry,
  record: ServerRecord,
  models: ModelDescriptor[],
): Promise<void> {
  unregisterServer(pi, record);
  await registerServer(pi, registry, record, models);
}
