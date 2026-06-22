/**
 * Factory-phase preload — register saved Crossbar providers before Pi resolves
 * model scopes.
 *
 * This module is intentionally minimal: it reads persisted config and calls
 * pi.registerProvider for each enabled server that has a cached model catalogue.
 * It NEVER performs network requests, discovery, UI work, timers, or credential
 * writes, and it NEVER throws — a failure here must not prevent Pi from starting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PersistenceOpts } from "./registry/persistence.ts";
import { loadConfig } from "./registry/persistence.ts";
import { registerCachedServer } from "./shim/provider-shim.ts";

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

  for (const record of cfg.servers) {
    try {
      if (!record.enabled) continue;
      if (!record.lastKnownModels || record.lastKnownModels.length === 0) continue;
      registerCachedServer(pi, record, record.lastKnownModels);
    } catch {
      // One malformed record must not block others.
    }
  }
}
