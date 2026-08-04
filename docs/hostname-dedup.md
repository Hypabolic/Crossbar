# Hostname Resolution & Deduplication

## Problem

A single inference server with multiple network interfaces appears as **multiple
entries** in the Crossbar server list:

```
oMLX (127.0.0.1:8000)              — loopback
oMLX (192.168.188.127:8000)        — WiFi NIC
oMLX (192.168.139.3:8000)          — VPN/virtual NIC
oMLX (macpro16.fritz.box:8000)     — hostname
```

All four entries point to the **same machine**. The user sees four identical
servers and must manually disable three of them.

## Solution

1. **Resolve** IP addresses to hostnames via reverse DNS.
2. **Deduplicate** by `hostname + port` — collapse all IPs of the same machine
   into a single entry.
3. **Prefer localhost** when Crossbar and the server are co-located.
4. **Prefer hostname** when they are on different machines.

## How it works

### Step 1 — Reverse DNS resolution

Each discovered IP is looked up via `dns.reverse()`:

| IP | Resolves to |
|---|---|
| `127.0.0.1` | `localhost` (no lookup needed) |
| `192.168.188.127` | `macpro16.fritz.box` |
| `192.168.139.3` | `macpro16.fritz.box` |
| `192.168.188.173` | `dagobert.fritz.box` |

**Caching:** Results are cached within a single scan run to avoid redundant
DNS calls. `clearCache()` is called between scans.

**Graceful fallback:** If reverse DNS fails, the original IP is retained.

### Step 2 — Dedup by hostname + port

Servers are grouped by their resolved `hostname:port` key. For each group with
more than one entry, we pick one using the rules below.

### Step 3 — Best endpoint selection

**Case A: Co-located** (Crossbar runs on the same machine as the server)

Both `localhost` and the hostname/IP are discovered. **Prefer `localhost`:**

| Before | After |
|---|---|
| `localhost:8000` | `localhost:8000` ✓ |
| `macpro16.fritz.box:8000` | _(removed)_ |
| `192.168.188.127:8000` | _(removed)_ |

**Detection:** Crossbar checks its own hostname/IP against the discovered
servers. If a server resolves to the same host as Crossbar itself, they are
co-located.

**Why:** localhost is faster (no network stack), more reliable (no NIC issues),
and more secure (port not exposed on the network).

**Case B: Remote** (Crossbar runs on a different machine)

Only the hostname/IP are discovered — `localhost` is not in the list.
**Use the hostname:**

| Before | After |
|---|---|
| `dagobert.fritz.box:8080` | `dagobert.fritz.box:8080` ✓ |

**Why:** the OS DNS resolver picks the best route based on interface metrics,
subnet affinity, and interface state.

### Implementation details

#### URL path preservation

We use **string replacement** (not `URL` object reconstruction) to replace
hostnames in URLs. This preserves the original path, query string, and hash
exactly, including whether a trailing slash was present.

```typescript
// Correct: replaces only the hostname in the original string
const re = new RegExp(`^(${parsed.protocol}//)${escaped}(:|/|$)`);
return url.replace(re, `$1${resolved}$2`);

// WRONG: URL object adds trailing slash even when the original had none
`${parsed.protocol}//${resolved}:${parsed.port}${parsed.pathname}${parsed.search}${parsed.hash}`
//  → "http://hostname:8080/"  (trailing slash breaks ${baseUrl}/v1)
```

#### Edge cases

| Scenario | Behavior |
|---|---|
| IP that resolves to same hostname as another IP | Collapsed to one entry |
| Different hostnames, same port | Kept as separate entries |
| Same hostname, different ports | Kept as separate entries |
| `localhost` + hostname (co-located) | Prefer `localhost` |
| `localhost` + hostname (remote) | Only hostname appears (localhost not discovered) |
| Unresolvable IP | Kept as raw IP (graceful degradation) |
| All IPs in a group unresolved, different | First in each group kept |
| Malformed URL | Returned as-is (no change) |
| IPv6 addresses | Skipped (no-op, treated as hostname) |

## Testing

### DNS resolution tests (`tests/discovery/dns.test.ts`)

17 tests covering:
- `resolveHostname`: skip localhost/IPv6, IP→hostname, DNS failure fallback,
  caching, `clearCache`
- `resolveUrlHostname`: skip localhost/127.0.0.1, IP→hostname in URL,
  preserves path/query/hash, **trailing-slash regression**, DNS failure
  fallback, malformed URL fallback, cross-URL caching

### Deduplication tests (`tests/discovery/hostname-dedup.test.ts`)

7 tests covering:
- Single entry unchanged
- Different hostnames kept separate
- Same hostname, different ports kept separate
- Multiple IPs → same hostname → collapses to one
- One IP resolves → preferred over unresolved IP
- All IPs unresolved → keeps first in group
- localhost + hostname → separate keys

### Integration

The `dedupByHostname()` function is called in both `discoverLocalhost()` and
`discoverLan()` after the initial port-based deduplication, ensuring consistent
behaviour across all discovery paths.
