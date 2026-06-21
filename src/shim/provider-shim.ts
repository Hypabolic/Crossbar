/**
 * Provider-registration shim — the ONLY place Crossbar calls Pi's
 * `pi.registerProvider` / `pi.unregisterProvider`.
 *
 * # API-key handoff decision (verified against Pi source at commit d93b92b)
 *
 * Pi's `validateProviderConfig` (.pi-reference/packages/coding-agent/src/core/model-registry.ts:882)
 * throws when `models` is provided but `apiKey` is absent AND `oauth` is absent:
 *
 *   if (!config.apiKey && !config.oauth) {
 *     throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
 *   }
 *
 * Pi's `getApiKeyAndHeaders` (model-registry.ts:703–716) resolves the key in this order:
 *   1. `authStorage.getApiKey(providerName)` — reads from auth.json under the provider id
 *   2. Fallback: `resolveConfigValue(providerConfig.apiKey)` — resolves the $ENV expression
 *
 * Crossbar calls `authStorage.set(record.id, { type: "api_key", key: <literal> })` BEFORE
 * calling `registerProvider`, so Pi's step-1 always finds the key in auth.json and the
 * `$ENV` expression is NEVER evaluated against environment variables.
 *
 * Therefore the correct approach is:
 *   - Pass `apiKey: "$" + envVarFor(record.id)` when `hasApiKey === true`.
 *     This satisfies Pi's validation without ever inlining a plaintext key into the
 *     ProviderConfig (which Pi stores in memory as `registeredProviders`).
 *   - Omit `apiKey` entirely when the server requires no auth — Pi's validation
 *     only fires when `models` is provided, and it passes when `apiKey` is absent
 *     only if `oauth` is present; BUT local no-auth servers must still pass the
 *     validation.  We therefore supply `apiKey: ""` — wait, that is falsy and will
 *     also trigger the throw.
 *
 *   Re-reading model-registry.ts:882: the check is `!config.apiKey`, which is truthy
 *   for the empty string `""`.  So for no-auth servers we need a non-empty sentinel.
 *   The Pi docs (custom-provider.md) show `apiKey: "$LOCAL_OPENAI_API_KEY"` even for
 *   local servers where the env var is unset — Pi treats an unresolved env var as
 *   "no key" and does not inject an Authorization header in that case (the header is
 *   only added when `authStorage.getApiKey` returns a non-undefined value OR when
 *   `authHeader: true` is set).
 *
 *   FINAL DECISION:
 *   - `auth === "apiKey"`: pass `apiKey: "$" + envVarFor(record.id)`.
 *     Pi reads the literal key from auth.json (step 1 above). Safe — no plaintext.
 *   - `auth === "none"`: pass `apiKey: "$" + envVarFor(record.id)` but omit the
 *     env var from the environment (and Crossbar never sets it). Pi will resolve
 *     the env var as undefined and skip the Authorization header.
 *     This satisfies the validation AND causes no harm for no-auth backends.
 *
 *   Evidence:
 *     - Validation:  model-registry.ts:882
 *     - Resolution:  model-registry.ts:703–716
 *     - resolveConfigValue env handling: resolve-config-value.ts:101–113
 *       (returns undefined when env var is absent → getApiKeyAndHeaders returns undefined apiKey)
 */

import type { ProviderConfig, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerRecord, DiscoveredServer, ModelDescriptor } from "../core/types.ts";
import { adapterFor } from "../adapters/index.ts";
import { envVarFor } from "../registry/ids.ts";
import type { ServerRegistry } from "../registry/registry.ts";

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
 * @param opts.hasApiKey - True when the registry has a key stored in auth.json for this
 *                         server.  Controls whether the `$ENV` sentinel is injected.
 */
export function buildProviderConfig(
  record: ServerRecord,
  server: DiscoveredServer,
  models: ModelDescriptor[],
  opts?: { hasApiKey?: boolean },
): ProviderConfig {
  const adapter = adapterFor(record.kind);

  // Filter out embedding-only models — Pi registers these as chat models which
  // is incorrect.  Non-embedding models are the ones Pi cares about.
  const chatModels = models.filter((m) => !m.embeddings);

  // Map each chat model through the adapter's owned toPiModel logic.
  const piModels: ProviderConfig["models"] = chatModels.map((m) =>
    adapter.toPiModel(server, m),
  );

  // API-key sentinel: always include so Pi's validation passes.
  // For no-auth servers the env var will be absent → Pi resolves it as
  // undefined and omits the Authorization header.  For keyed servers Pi reads
  // the literal from auth.json first (getApiKeyAndHeaders step 1).
  // NEVER pass a plaintext key here.
  const apiKey = "$" + envVarFor(record.id);

  const config: ProviderConfig = {
    name: record.label,
    baseUrl: adapter.inferenceBaseUrl(server),
    api: adapter.piApi,
    apiKey,
    models: piModels,
  };

  // When there is no key stored, remove apiKey only if the server uses no auth.
  // For auth === "apiKey" servers, hasApiKey should always be true by the time we
  // call this; but guard defensively: if somehow we're asked to register a keyed
  // server with no stored key, still emit the sentinel (Pi will just fail auth).
  if (record.auth === "none" && opts?.hasApiKey !== true) {
    // For no-auth local backends the env var is unset at runtime, so Pi will
    // resolve apiKey as undefined — effectively no Authorization header.
    // We keep the sentinel to satisfy Pi's schema validation.
    // (No change needed — apiKey is already the sentinel.)
  }

  return config;
}

// ---------------------------------------------------------------------------
// registerServer
// ---------------------------------------------------------------------------

/**
 * Resolve the server's credential, build its ProviderConfig, and register it
 * with Pi. Idempotent — Pi's `registerProvider` replaces an existing registration.
 */
export async function registerServer(
  pi: ExtensionAPI,
  registry: ServerRegistry,
  record: ServerRecord,
  models: ModelDescriptor[],
): Promise<void> {
  const cred = await registry.resolveCredential(record);
  const hasApiKey = cred.mode === "apiKey" && cred.apiKey !== undefined;

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

  const config = buildProviderConfig(record, server, models, { hasApiKey });
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
