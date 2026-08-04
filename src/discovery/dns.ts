/**
 * DNS hostname resolution for discovered servers.
 *
 * Resolves IP addresses to hostnames via reverse DNS (`dns.reverse()`).
 * Results are cached within a scan run to avoid redundant lookups.
 * Resolution failures fall back to the original value (graceful degradation).
 *
 * Hostnames are displayed without their domain suffix (e.g. `macpro16.fritz.box`
 * → `macpro16`) to save horizontal space in the UI. The full hostname is
 * preserved in the `baseUrl` for correct DNS resolution.
 *
 * Shortening only applies to hostnames that share the same domain suffix as
 * the machine Crossbar is running on (detected via `os.hostname()`). Hostnames
 * on different domains are kept in full to avoid label collisions.
 */

import { reverse } from "node:dns/promises";
import { hostname } from "node:os";

// ---------------------------------------------------------------------------
// Local domain suffix — extracted from this machine's own hostname
// ---------------------------------------------------------------------------

/**
 * Get the domain suffix of the local machine, or null if the hostname has no dot.
 * Computed lazily so tests can mock `os.hostname()` before first access.
 *
 * Examples:
 *   `myMac.fritz.box`     → `.fritz.box`
 *   `myMac.home.arpa`     → `.home.arpa`
 *   `localhost`           → `null`
 */
export function getLocalDomain(): string | null {
  const localHostname = hostname();
  const dotIndex = localHostname.indexOf(".");
  return dotIndex > 0 ? localHostname.slice(dotIndex) : null;
}

// ---------------------------------------------------------------------------
// Cache — keyed by IP address, values are resolved hostnames or null on failure
// ---------------------------------------------------------------------------

const cache = new Map<string, string | null>();

/** Clear the cache between scan runs. */
export function clearCache(): void {
  cache.clear();
}

/**
 * Strip the domain suffix from a hostname for display.
 *
 * Only shortens hostnames that share the same domain suffix as the local
 * machine (e.g. `macpro16.fritz.box` → `macpro16` when local is `myMac.fritz.box`).
 * Hostnames on different domains are kept in full to avoid label collisions.
 *
 * @param hostname - The hostname to potentially shorten.
 * @returns The short hostname, or the original if no shortening applies.
 */
export function shortHostname(hostname: string): string {
  // Don't strip dots from IP addresses
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(hostname)) return hostname; // IPv6

  // No local domain suffix (e.g. localhost) — no shortening
  const localDomain = getLocalDomain();
  if (!localDomain) return hostname;

  // Only shorten if the hostname shares our local domain suffix (case-insensitive)
  const lowerHost = hostname.toLowerCase();
  if (!lowerHost.endsWith(localDomain.toLowerCase())) return hostname;

  return hostname.slice(0, hostname.indexOf("."));
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an IP address to a hostname via reverse DNS.
 * Returns the original IP if resolution fails (graceful degradation).
 *
 * Cached within a scan run — repeated calls with the same IP reuse the result.
 *
 * @param ip - The IP address to resolve.
 * @returns The resolved hostname, or the original IP on failure.
 */
export async function resolveHostname(ip: string): Promise<string> {
  // Skip already-hostname-like values
  if (ip === "localhost" || ip === "127.0.0.1" || ip === "::1") return ip;
  if (ip.includes(":")) return ip; // IPv6 — skip

  // Check cache first — null means we already tried and it failed
  const cached = cache.get(ip);
  if (cached !== undefined) return cached as string;

  try {
    const hostnames = await reverse(ip);
    // reverse() returns (string | null)[]; take the first non-null entry
    const hostname = hostnames[0] as string;
    if (hostname) {
      cache.set(ip, hostname);
      return hostname;
    }
  } catch {
    // DNS resolution failed — fall back to original IP
  }

  cache.set(ip, ip);
  return ip;
}

/**
 * Resolve the host part of a full URL to a hostname.
 *
 * Examples:
 *   `http://192.168.1.42:11434` → `http://workstation.local:11434`
 *   `http://10.0.0.5:8000`      → `http://devbox.local:8000`
 *   `http://localhost:8000`      → `http://localhost:8000` (no-op)
 *
 * @param url - The full URL to resolve.
 * @returns The URL with the host part resolved, or the original URL on failure.
 */
export async function resolveUrlHostname(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Malformed URL — return as-is
    return url;
  }

  const hostname = parsed.hostname;

  // Skip if already a hostname-like value
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return url;
  if (hostname.includes(":")) return url; // IPv6 — skip

  const resolved = await resolveHostname(hostname);

  // No change — return original
  if (resolved === hostname) return url;

  // Replace only the hostname in the original string — preserves whether the
  // original URL had a trailing slash/path or not (avoids introducing a
  // spurious "/" that breaks downstream path concatenation, e.g. `${baseUrl}/v1`
  // becoming a double slash).
  const hostPattern = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escape regex chars
  const re = new RegExp(`^(${parsed.protocol}//)${hostPattern}(:|/|$)`);
  return url.replace(re, `$1${resolved}$2`);
}
