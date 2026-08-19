/**
 * Factory-phase preload — register saved Crossbar providers before Pi resolves
 * model scopes.
 *
 * This module is intentionally minimal: it reads persisted config and calls
 * pi.registerProvider for each enabled server that has a cached model catalogue.
 * It NEVER performs network requests, discovery, UI work, timers, or credential
 * writes, and it NEVER throws — a failure here must not prevent Pi from starting.
 *
 * It DOES perform one credential READ: for `auth: "apiKey"` records, it looks up the
 * already-persisted key (auth.json, via the same store `registerServer()` uses at
 * session_start) and bridges it into `process.env[envVarFor(record.id)]` — the exact
 * variable the `$ENV` sentinel in `buildProviderConfig()` references. Without this, a keyed
 * server's preloaded models would be unusable (`pi.setModel()` returns false) for the brief
 * window between factory load and `session_start`'s authoritative `refreshAndRegister()`
 * pass, which performs the same bridge. See `shim/provider-shim.ts`'s header for why Pi's own
 * config-value resolver needs this rather than resolving auth.json by provider id itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PersistenceOpts } from "./registry/persistence.ts";
import { loadConfig } from "./registry/persistence.ts";
import { registerCachedServer } from "./shim/provider-shim.ts";
import { createAuthJsonCredentialStore } from "./registry/auth-json-credential-store.ts";
import { envVarFor } from "./registry/ids.ts";

/**
 * Read crossbar.json and register each enabled server with a non-empty chat
 * model cache with Pi. Called as the first statement in the extension factory.
 *
 * @param pi   - The Pi ExtensionAPI instance.
 * @param opts - Optional persistence options (dir override for tests).
 */
export async function preloadCachedProviders(
  pi: ExtensionAPI,
  opts?: PersistenceOpts,
): Promise<void> {
  let cfg;
  try {
    cfg = await loadConfig(opts);
  } catch {
    // loadConfig is already tolerant, but guard here too — never throw from factory.
    return;
  }

  const credentialStore = createAuthJsonCredentialStore(
    opts?.dir ? { authPath: `${opts.dir}/auth.json` } : undefined,
  );

  for (const record of cfg.servers) {
    try {
      if (!record.enabled) continue;
      if (!record.lastKnownModels || record.lastKnownModels.length === 0) continue;
      if (record.auth === "apiKey") {
        const key = await credentialStore.get(record.id);
        // Bridge the key into process.env when we already have one cached; when we don't
        // (first-ever load before any key was entered, or a store read failure), still
        // register with the unresolved `$ENV` sentinel exactly as before this bridge existed
        // — session_start's refreshAndRegister() re-registers every enabled record shortly
        // after with an authoritative credential resolution regardless.
        if (key !== undefined) process.env[envVarFor(record.id)] = key;
      }
      registerCachedServer(pi, record, record.lastKnownModels);
    } catch {
      // One malformed record must not block others.
    }
  }
}
