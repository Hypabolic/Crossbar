/**
 * Health-poll orchestration.
 *
 * Each tick, for every enabled server: probe `health` (and, only for backends without a
 * health endpoint, a single `listModels` as the reachability signal). The model catalogue
 * is NOT re-listed here — it is refreshed only when needed (startup, /crossbar Rescan, and
 * manage actions), so a backgrounded session never polls the backend for models. Results
 * are written to the registry's ephemeral cache (`setHealth`, `updateHealthCache`).
 *
 * Pure orchestration over injected collaborators (registry + adapters + the shim);
 * never calls `fetch` directly — only the adapter via the injected `Probe`.
 */

import { adapterFor } from "./adapters/index.ts";
import { supports } from "./core/backend-adapter.ts";
import { Capability } from "./core/capability.ts";
import type { DiscoveredServer, HealthState, ModelDescriptor, ServerRecord } from "./core/types.ts";
import { createProbe } from "./discovery/probe.ts";
import type { ServerRegistry } from "./registry/registry.ts";

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
 * True when two model lists differ in a way that is registration-relevant.
 *
 * Returns true when:
 *   - the id SET differs (delegates to modelsChanged), OR
 *   - for any id present in both: name, contextWindow, maxTokens, input
 *     (as a sorted set), reasoning, tools, or embeddings changed.
 *
 * Order of models in the list does not matter — only content changes do.
 * The existing `modelsChanged` export is kept intact with id-only semantics.
 */
export function catalogueChanged(
  prev: ModelDescriptor[] | undefined,
  next: ModelDescriptor[],
): boolean {
  // Fast path: if the id set changed, we're done.
  if (modelsChanged(prev, next)) return true;

  // Same id set — check registration-relevant metadata for each shared id.
  const prevMap = new Map((prev ?? []).map((m) => [m.id, m]));
  for (const n of next) {
    const p = prevMap.get(n.id);
    if (!p) continue; // shouldn't happen after modelsChanged check, but be safe
    if (p.name !== n.name) return true;
    if (p.contextWindow !== n.contextWindow) return true;
    if (p.maxTokens !== n.maxTokens) return true;
    // Compare input modalities as sorted sets.
    const pi = [...p.input].sort().join(",");
    const ni = [...n.input].sort().join(",");
    if (pi !== ni) return true;
    if (p.reasoning !== n.reasoning) return true;
    if (p.tools !== n.tools) return true;
    if (p.embeddings !== n.embeddings) return true;
  }
  return false;
}

/**
 * Poll a single server: probe health (or one reachability listModels for health-less
 * backends) and write the result to the registry cache. Returns the observed health
 * state. Probes are caught and reported as `unreachable`; `pollAll` additionally
 * isolates any per-server rejection so one bad server never aborts the tick.
 */
export async function pollServer(
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

  // 2) The periodic poll no longer re-lists the model catalogue — that is refreshed
  //    only when needed (startup, /crossbar Rescan, manage actions), not on a timer,
  //    so a backgrounded session stays silent. Backends WITHOUT a health endpoint have
  //    no other reachability signal, so for those we still do one cheap listModels and
  //    infer reachability from it (but never re-register from the periodic path).
  if (!hasHealth) {
    try {
      await adapter.listModels(server, cred, probe);
      health = "healthy";
    } catch {
      health = "unreachable";
    }
  }
  if (health !== "unreachable") {
    registry.updateHealthCache(record.id, { lastSeenAt: Date.now() });
  }

  registry.setHealth(record.id, health);
  return health;
}

/** Poll every enabled server concurrently; failures are isolated per server. */
export async function pollAll(registry: ServerRegistry): Promise<void> {
  const records = registry.list().filter((r) => r.enabled);
  await Promise.allSettled(records.map((r) => pollServer(registry, r)));
}
