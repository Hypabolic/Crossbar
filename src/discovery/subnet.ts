/**
 * Subnet / host-spec expansion for LAN discovery.
 *
 * LAN discovery has no mDNS to listen to, so it works by actively probing addresses.
 * To make it *actually discover* without the user enumerating every host, we:
 *   - auto-detect the machine's own private IPv4 subnet(s) (`localSubnetCidrs`), and
 *   - expand host specs — plain host, CIDR (`10.0.1.0/24`), or last-octet range
 *     (`10.0.1.10-50`) — into concrete addresses (`expandHosts`), capped for safety.
 *
 * Pure and dependency-free apart from `node:os` (injectable for tests).
 */

import { networkInterfaces } from "node:os";

/** Default ceiling on expanded hosts so an over-broad CIDR can't explode a sweep. */
export const DEFAULT_MAX_HOSTS = 1024;

// ─── IPv4 integer helpers ────────────────────────────────────────────────────

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipToInt(ip);
  if (n === null) return false;
  const a = (n >>> 24) & 255;
  const b = (n >>> 16) & 255;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

// ─── CIDR ────────────────────────────────────────────────────────────────────

const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;

/** Convert an interface CIDR (e.g. "10.0.1.23/24") to its network CIDR ("10.0.1.0/24"). */
export function networkCidr(addrCidr: string): string | null {
  const m = CIDR_RE.exec(addrCidr);
  if (!m) return null;
  const baseInt = ipToInt(m[1]!);
  const prefix = Number(m[2]);
  if (baseInt === null || prefix > 32) return null;
  const hostBits = 32 - prefix;
  const maskHost = hostBits >= 32 ? 0xffffffff : 2 ** hostBits - 1;
  const network = (baseInt & ~maskHost) >>> 0;
  return `${intToIp(network)}/${prefix}`;
}

/** Expand a CIDR to usable host addresses (network + broadcast excluded for prefix ≤ 30). */
function expandCidr(cidr: string, cap: number): { hosts: string[]; truncated: boolean } | null {
  const m = CIDR_RE.exec(cidr);
  if (!m) return null;
  const baseInt = ipToInt(m[1]!);
  const prefix = Number(m[2]);
  if (baseInt === null || prefix > 32) return null;

  const hostBits = 32 - prefix;
  const maskHost = hostBits >= 32 ? 0xffffffff : 2 ** hostBits - 1;
  const network = (baseInt & ~maskHost) >>> 0;
  const total = hostBits >= 32 ? 2 ** 32 : 2 ** hostBits;

  // Skip the network and broadcast addresses for a normal subnet (/30 or wider).
  const start = prefix <= 30 ? 1 : 0;
  const end = prefix <= 30 ? total - 2 : total - 1;

  const hosts: string[] = [];
  for (let i = start; i <= end && hosts.length < cap; i++) {
    hosts.push(intToIp((network + i) >>> 0));
  }
  const fullCount = Math.max(0, end - start + 1);
  return { hosts, truncated: hosts.length < fullCount };
}

const RANGE_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/;

/**
 * Expand a list of host specs into concrete, de-duplicated addresses.
 * Each spec may be a plain host/hostname, a CIDR, or a last-octet range.
 * The result is capped at `maxHosts`; `truncated` is true if anything was dropped.
 */
export function expandHosts(
  specs: string[],
  maxHosts: number = DEFAULT_MAX_HOSTS,
): { hosts: string[]; truncated: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const push = (host: string): void => {
    if (!seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  };

  for (const raw of specs) {
    const spec = raw.trim();
    if (spec.length === 0) continue;
    const remaining = maxHosts - out.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (spec.includes("/")) {
      const r = expandCidr(spec, remaining);
      if (!r) continue; // malformed CIDR — drop rather than probe a bogus origin
      if (r.truncated) truncated = true;
      r.hosts.forEach(push);
      continue;
    }

    const range = RANGE_RE.exec(spec);
    if (range) {
      const lo = Math.min(Number(range[2]), Number(range[3]));
      const hi = Math.max(Number(range[2]), Number(range[3]));
      if (hi > 255) continue;
      for (let i = lo; i <= hi; i++) {
        if (out.length >= maxHosts) {
          truncated = true;
          break;
        }
        push(`${range[1]}.${i}`);
      }
      continue;
    }

    push(spec); // plain host or hostname
  }

  return { hosts: out, truncated };
}

/**
 * Detect the machine's own private IPv4 subnet(s) as network CIDRs, e.g. ["10.0.0.0/24"].
 * Only RFC1918 ranges and subnets of /22 or smaller are returned, so "scan my LAN" never
 * silently tries to sweep a public or enormous range. `ifaces` is injectable for tests.
 */
export function localSubnetCidrs(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      const isV4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (!isV4 || entry.internal || !entry.cidr) continue;
      if (!isPrivateIPv4(entry.address)) continue;
      const net = networkCidr(entry.cidr);
      if (!net) continue;
      const prefix = Number(net.split("/")[1]);
      if (prefix < 22) continue; // refuse to auto-sweep anything larger than ~1k hosts
      if (!seen.has(net)) {
        seen.add(net);
        out.push(net);
      }
    }
  }
  return out;
}
