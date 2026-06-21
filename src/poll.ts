/**
 * Health-poll orchestration.
 *
 * Each tick, for every enabled server: probe `health`, refresh the model list, and
 * re-register with Pi only when the model set actually changed. Results are written
 * to the registry's ephemeral cache (`setHealth`, `updateHealthCache`) so the loaded
 * widget can render live health + a fresh model list without doing its own I/O for
 * those fields.
 *
 * Pure orchestration over injected collaborators (registry + adapters + the shim);
 * never calls `fetch` directly — only the adapter via the injected `Probe`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { adapterFor } from "./adapters/index.ts";
import { supports } from "./core/backend-adapter.ts";
import { Capability } from "./core/capability.ts";
import type { DiscoveredServer, HealthState, ModelDescriptor, ServerRecord } from "./core/types.ts";
import { createProbe } from "./discovery/probe.ts";
import type { ServerRegistry } from "./registry/registry.ts";
import { reRegisterServer } from "./shim/provider-shim.ts";

/** Reconstruct a minimal DiscoveredServer from a persisted record for adapter calls. */
function serverOf(record: ServerRecord): DiscoveredServer {
  return {
    kind: record.kind,
    baseUrl: record.baseUrl,
    auth: record.auth,
    label: record.label,
    confidence: 1,
  };
}

/** True when two model lists differ by membership (id set), order-independent. */
export function modelsChanged(
  prev: ModelDescriptor[] | undefined,
  next: ModelDescriptor[],
): boolean {
  const a = (prev ?? []).map((m) => m.id).sort();
  const b = next.map((m) => m.id).sort();
  if (a.length !== b.length) return true;
  return a.some((id, i) => id !== b[i]);
}

/**
 * Poll a single server: refresh health + models, re-register on change, and write
 * the results to the registry cache. Returns the observed health state. The health
 * and model probes are caught and reported as `unreachable`; `pollAll` additionally
 * isolates any per-server rejection so one bad server never aborts the tick.
 */
export async function pollServer(
  pi: ExtensionAPI,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<HealthState> {
  const adapter = adapterFor(record.kind);
  const cred = await registry.resolveCredential(record);
  const probe = createProbe(record.baseUrl, { auth: cred });
  const server = serverOf(record);
  const hasHealth = supports(adapter, Capability.Health) && typeof adapter.health === "function";

  // 1) Explicit health probe when the backend supports one.
  let health: HealthState = "unreachable";
  if (hasHealth) {
    try {
      health = (await adapter.health!(server, cred, probe)).state;
    } catch {
      health = "unreachable";
    }
  }

  // 2) Refresh the model list; re-register only when the set changed. For backends
  //    without a health endpoint, listModels success/failure infers reachability.
  try {
    const models = await adapter.listModels(server, cred, probe);
    if (modelsChanged(record.lastKnownModels, models)) {
      await reRegisterServer(pi, registry, record, models);
    }
    registry.updateHealthCache(record.id, { models, lastSeenAt: Date.now() });
    if (!hasHealth) health = "healthy";
  } catch {
    if (!hasHealth) health = "unreachable";
  }

  registry.setHealth(record.id, health);
  return health;
}

/** Poll every enabled server concurrently; failures are isolated per server. */
export async function pollAll(pi: ExtensionAPI, registry: ServerRegistry): Promise<void> {
  const records = registry.list().filter((r) => r.enabled);
  await Promise.allSettled(records.map((r) => pollServer(pi, registry, r)));
}
