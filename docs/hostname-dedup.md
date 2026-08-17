# Hostname Resolution & Deduplication

## Problem

A single inference server with multiple network interfaces appears as **multiple
entries** in the Crossbar server list:

```
oMLX (192.168.188.127:8000)        — WiFi NIC
oMLX (192.168.139.3:8000)          — VPN/virtual NIC
oMLX (workstation.local:8000)     — hostname
```

All three LAN entries point to the **same machine**. The user sees duplicate
servers and must manually ignore the extras.

## Solution

1. **Resolve** IP addresses to hostnames via reverse DNS.
2. **Deduplicate** by `hostname + port` — collapse all IPs of the same machine
   into a single entry.
3. **Prefer hostname** over a still-unresolved IP when both land in the same group.
4. **Shorten labels** by stripping the shared local domain suffix for display.

Loopback (`127.0.0.1` / `localhost`) is a different key from a LAN hostname, so a
co-located server can still appear twice (once from the localhost sweep, once from
LAN) when both paths discover it. That is intentional: the URLs differ, and the
localhost entry is the better default for a local session.

## How it works

### Step 1 — Reverse DNS resolution

Each discovered IP is looked up via `dns.reverse()`:

| IP | Resolves to |
|---|---|
| `127.0.0.1` | `127.0.0.1` (no lookup) |
| `192.168.188.127` | `workstation.local` |
| `192.168.139.3` | `workstation.local` |

**Caching:** Results are cached within a single `discoverLocalhost` /
`discoverLan` call. `clearCache()` runs at the start of each call.

**Graceful fallback:** If reverse DNS fails, the original IP is retained.

### Step 2 — Dedup by hostname + port

Servers are grouped by their resolved `hostname:port` key. For each group with
more than one entry, the entry with a resolved hostname is preferred over an IP.

### Label shortening

Hostnames are displayed **without their domain suffix** to save horizontal
space in the UI. This only applies to hostnames that share the same domain
suffix as the machine Crossbar is running on (via `os.hostname()`, env hints, or
`/etc/resolv.conf`).

| Local machine | Displayed label | Full hostname (baseUrl) |
|---|---|---|
| `local-host.fritz.box` | `devbox:8080` | `devbox.fritz.box` |
| `local-host.fritz.box` | `remote.example.com:8080` | `remote.example.com` |
| `local-host.fritz.box` | `192.168.188.173:8080` | `192.168.188.173` |

### URL path preservation

Hostname replacement uses string replacement (not `URL` reconstruction) so
trailing slashes and paths are preserved — reconstructing via `URL` can introduce
a spurious `/` that breaks `${baseUrl}/v1` concatenation.

## Testing

- `tests/discovery/dns.test.ts` — resolve, shorten, cache, resolv.conf fallback
- `tests/discovery/hostname-dedup.test.ts` — multi-NIC collapse, preference, labels
