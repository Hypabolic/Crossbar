/**
 * Crossbar discovery engine.
 *
 * Sweeps a set of origins (host × port) with each non-cloud adapter's `fingerprint()`, picks the
 * highest-confidence match per origin, and returns the deduplicated list of discovered servers.
 *
 * Design decisions:
 *  - Bounded concurrency (default 8 parallel probes) to avoid overwhelming localhost or LAN.
 *  - Cloud adapters (openai, anthropic) are skipped — they are configured, not probed.
 *  - Tie-break: when two adapters return equal confidence, prefer the more specific one over
 *    "openai-generic" (the catch-all fallback).
 *  - Dedupe by normalised origin string (protocol + host + port, lower-cased, no trailing slash).
 *  - `discoverLan` is an opt-in variant that accepts an explicit host list; no mDNS.
 */

import { CLOUD_KINDS } from "../core/capability.ts";
import type { BackendAdapter } from "../core/backend-adapter.ts";
import type { DiscoveredServer, Probe } from "../core/types.ts";
import { createProbe } from "./probe.ts";
import { resolveUrlHostname, clearCache } from "./dns.ts";

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

import { resolveHostname } from "./dns.ts";

/** Extract the hostname+port key from a baseUrl for deduplication. */
function hostPortKey(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return baseUrl; // malformed — use as-is
  }
  return `${parsed.hostname.toLowerCase()}:${parsed.port}`;
}

/** Check if a string looks like an IPv4 address. */
function isIpv4(s: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(s);
}

/**
 * Keep only one entry per resolved hostname+port key.
 * Resolves any unresolved IPs so that multiple IPs of the same machine
 * (e.g., different NICs) collapse to the same hostname.
 * Prefers the entry with a resolved hostname over an IP.
 */
export async function dedupByHostname(servers: DiscoveredServer[]): Promise<DiscoveredServer[]> {
  // Resolve any unresolved IPs — reuse dns cache if available
  const entries = await Promise.all(
    servers.map(async (server) => {
      const key = hostPortKey(server.baseUrl);
      const parsed = new URL(server.baseUrl);
      const hostname = parsed.hostname;
      if (isIpv4(hostname)) {
        const resolved = await resolveHostname(hostname);
        if (resolved !== hostname) {
          // Update the entry with the resolved hostname
          return {
            ...server,
            baseUrl: `${parsed.protocol}//${resolved}:${parsed.port}${parsed.pathname}${parsed.search}${parsed.hash}`,
            label: server.label.replace(hostname, resolved),
          };
        }
      }
      return server;
    }),
  );

  // Group by resolved hostname:port
  const groups = new Map<string, DiscoveredServer[]>();
  for (const server of entries) {
    const key = hostPortKey(server.baseUrl);
    const list = groups.get(key) ?? [];
    groups.set(key, list);
    list.push(server);
  }

  const result: DiscoveredServer[] = [];
  for (const [_key, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Prefer resolved hostname over IP
    const withHostname = group.find(
      (s) => !isIpv4(new URL(s.baseUrl).hostname) && !new URL(s.baseUrl).hostname.includes("["),
    );
    result.push(withHostname ?? group[0]);
  }
  return result;
}


/** Default localhost ports probed in order (from CAPABILITY-MATRIX.md). */
export const DEFAULT_PROBE_PORTS: readonly number[] = [
  11434, // Ollama
  1234,  // LM Studio
  8080,  // llama-server / llama-swap / llamafile
  8000,  // vLLM
  5000,  // TabbyAPI / oobabooga
  5001,  // KoboldCpp
  1337,  // Jan
];

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 600;
const DEFAULT_CONCURRENCY = 8;

// ────────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────────

/** Normalise an origin to a consistent, dedupe-safe string. */
function normalizeOrigin(protocol: string, host: string, port: number): string {
  return `${protocol}//${host}:${port}`;
}

/**
 * Run at most `concurrency` tasks at a time from an iterable of async thunks, collecting results.
 * Rejected tasks are silently dropped (individual probe errors are already caught inside `probe`).
 */
async function runBounded<T>(
  tasks: Array<() => Promise<T | null>>,
  concurrency: number,
): Promise<Array<T>> {
  const results: Array<T> = [];
  const queue = tasks.slice();

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      try {
        const result = await task();
        if (result !== null && result !== undefined) {
          results.push(result);
        }
      } catch {
        // Swallow; probe errors are already normalised to status:0 inside createProbe
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Given all fingerprint results for a single origin, select the best candidate:
 *  1. Highest confidence wins.
 *  2. Among equal-confidence candidates, prefer a specific adapter over "openai-generic".
 */
function selectBest(candidates: DiscoveredServer[]): DiscoveredServer | null {
  if (candidates.length === 0) return null;

  return candidates.reduce<DiscoveredServer>((best, candidate) => {
    if (candidate.confidence > best.confidence) return candidate;
    if (candidate.confidence === best.confidence) {
      // Tie-break: demote openai-generic; keep the more specific one
      if (best.kind === "openai-generic" && candidate.kind !== "openai-generic") {
        return candidate;
      }
    }
    return best;
  }, candidates[0]!);
}

/** Builds the Probe used for one origin. Overridable for tests (default: real network probe). */
export type ProbeFactory = (origin: string, timeoutMs: number) => Probe;

/**
 * Probe a single origin against every eligible adapter, return the best match or null.
 * Exported so integration tests can exercise the real selection logic with a fake probe.
 */
export async function probeOrigin(
  origin: string,
  adapters: BackendAdapter[],
  timeoutMs: number,
  probeFactory?: ProbeFactory,
): Promise<DiscoveredServer | null> {
  const probe = probeFactory
    ? probeFactory(origin, timeoutMs)
    : createProbe(origin, { defaultTimeoutMs: timeoutMs });

  // Run all adapter fingerprints concurrently for this single origin
  const fingerprintResults = await Promise.all(
    adapters.map(async (adapter): Promise<DiscoveredServer | null> => {
      try {
        return await adapter.fingerprint(origin, probe);
      } catch {
        return null;
      }
    }),
  );

  const candidates = fingerprintResults.filter((r): r is DiscoveredServer => r !== null);
  return selectBest(candidates);
}

// ────────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────────

export interface DiscoverLocalhostOptions {
  /** Override the default probe ports. */
  ports?: number[];
  /** Override the default host (127.0.0.1). */
  host?: string;
  /** Per-probe timeout in ms (default 600). */
  timeoutMs?: number;
  /** Abort signal to cancel a sweep in progress. */
  signal?: AbortSignal;
  /** Override how the per-origin Probe is built (tests inject a fake probe here). */
  probeFactory?: ProbeFactory;
}

/**
 * Sweep localhost (or a custom host) on the given ports, fingerprint each live origin, and return
 * the deduplicated list of discovered servers — one per origin, highest-confidence adapter wins.
 *
 * Non-cloud adapters only; cloud adapters (openai, anthropic) are skipped — they are configured
 * via Pi's own `/login`, not discovered by port sweeping.
 */
export async function discoverLocalhost(
  adapters: BackendAdapter[],
  opts?: DiscoverLocalhostOptions,
): Promise<DiscoveredServer[]> {
  const ports = opts?.ports ?? DEFAULT_PROBE_PORTS;
  const host = opts?.host ?? DEFAULT_HOST;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts?.signal;

  // Filter to non-cloud adapters only
  const localAdapters = adapters.filter((a) => !CLOUD_KINDS.has(a.kind));
  if (localAdapters.length === 0) return [];

  const origins = ports.map((port) => normalizeOrigin("http:", host, port));

  // Build per-origin tasks for bounded concurrency
  const tasks = origins.map((origin) => async (): Promise<DiscoveredServer | null> => {
    if (signal?.aborted) return null;
    return probeOrigin(origin, localAdapters, timeoutMs, opts?.probeFactory);
  });

  const allMatches = await runBounded(tasks, DEFAULT_CONCURRENCY);

  // Dedupe by normalised origin (the fingerprint may produce the same baseUrl from different paths)
  const seen = new Set<string>();
  const deduplicated: DiscoveredServer[] = [];
  for (const server of allMatches) {
    const key = server.baseUrl.toLowerCase().replace(/\/+$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(server);
    }
  }

  // Resolve hostnames in parallel — updates both baseUrl and label.
  const resolved = await Promise.all(
    deduplicated.map(async (server) => {
      const newBaseUrl = await resolveUrlHostname(server.baseUrl);
      if (newBaseUrl === server.baseUrl) return server; // no change
      return {
        ...server,
        baseUrl: newBaseUrl,
        label: server.label.replace(server.baseUrl, newBaseUrl),
      };
    }),
  );

  // Dedup by hostname+port — collapses multiple IPs of the same machine
  return await dedupByHostname(resolved);
}

export interface DiscoverLanOptions {
  /** Per-probe timeout in ms (default 600). */
  timeoutMs?: number;
  /** Ports to probe on each host (defaults to DEFAULT_PROBE_PORTS). */
  ports?: number[];
  /**
   * Max parallel origins. With {@link livenessFirst} a dead origin costs one socket,
   * so a subnet sweep can run this far higher than the localhost default of 8.
   */
  concurrency?: number;
  /**
   * Probe each origin with one cheap request first and skip the full adapter
   * fingerprint chain when nothing is listening. Keeps socket use ≈ concurrency
   * during a wide sweep (most addresses are dead), so concurrency can be raised safely.
   */
  livenessFirst?: boolean;
  /** Abort signal to cancel a sweep in progress. */
  signal?: AbortSignal;
  /** Override how the per-origin Probe is built (tests inject a fake probe here). */
  probeFactory?: ProbeFactory;
}

/**
 * Opt-in LAN discovery. Probes an explicit list of hosts × ports — no mDNS, just active TCP
 * connect attempts. Call only when `CrossbarSettings.lanDiscovery` is true and the user has
 * supplied host ranges or an explicit list.
 *
 * Follows the same fingerprinting and deduplication logic as `discoverLocalhost`.
 */
export async function discoverLan(
  adapters: BackendAdapter[],
  hosts: string[],
  opts?: DiscoverLanOptions,
): Promise<DiscoveredServer[]> {
  if (hosts.length === 0) return [];

  const ports = opts?.ports ?? DEFAULT_PROBE_PORTS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
  const livenessFirst = opts?.livenessFirst ?? false;
  const signal = opts?.signal;

  const localAdapters = adapters.filter((a) => !CLOUD_KINDS.has(a.kind));
  if (localAdapters.length === 0) return [];

  // Enumerate host × port origins
  const origins: string[] = [];
  for (const host of hosts) {
    for (const port of ports) {
      origins.push(normalizeOrigin("http:", host, port));
    }
  }

  const tasks = origins.map((origin) => async (): Promise<DiscoveredServer | null> => {
    if (signal?.aborted) return null;
    // Liveness gate: for a wide subnet sweep, most addresses are dead. A single
    // cheap request first means a dead origin costs ONE socket (not one per
    // adapter), so concurrency can be raised without exhausting file descriptors.
    if (livenessFirst) {
      const probe = opts?.probeFactory
        ? opts.probeFactory(origin, timeoutMs)
        : createProbe(origin, { defaultTimeoutMs: timeoutMs });
      let alive = false;
      try {
        alive = (await probe("/")).status !== 0; // status 0 = no TCP connection
      } catch {
        alive = false;
      }
      if (!alive) return null;
    }
    return probeOrigin(origin, localAdapters, timeoutMs, opts?.probeFactory);
  });

  const allMatches = await runBounded(tasks, concurrency);

  const seen = new Set<string>();
  const deduplicated: DiscoveredServer[] = [];
  for (const server of allMatches) {
    const key = server.baseUrl.toLowerCase().replace(/\/+$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(server);
    }
  }

  // Resolve hostnames in parallel — updates both baseUrl and label.
  const resolved = await Promise.all(
    deduplicated.map(async (server) => {
      const newBaseUrl = await resolveUrlHostname(server.baseUrl);
      if (newBaseUrl === server.baseUrl) return server; // no change
      return {
        ...server,
        baseUrl: newBaseUrl,
        label: server.label.replace(server.baseUrl, newBaseUrl),
      };
    }),
  );

  // Dedup by hostname+port — collapses multiple IPs of the same machine
  return await dedupByHostname(resolved);
}
