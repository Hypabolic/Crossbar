# Hostname shortening and LAN deduplication

## Problem

- LAN domain suffixes (`.fritz.box`, `.home.arpa`, AD domains, …) make labels wider than necessary, reducing the number of servers visible per row in `/crossbar`.
- Multiple network interfaces or IP versions can produce several discovered entries for the same physical machine.
- `os.hostname()` often returns only the bare hostname (e.g. `macPro16`), so the domain suffix of remote servers could not be stripped reliably.

## Solution

### Local domain detection (`src/discovery/dns.ts`)

`getLocalDomain()` determines the local machine's domain suffix using a cascading, best-effort strategy:

1. **`os.hostname()`** — if it already contains a dot, the suffix is extracted directly.
2. **Environment variables** — checked in order: `USERDNSDOMAIN`, `LOCALDOMAIN`, `DOMAIN` (covers Windows AD domains and common Unix env vars).
3. **`/etc/resolv.conf`** — parsed for `search` or `domain` directives; the first search domain wins.

The function is lazy and cached. Each step is wrapped in `try/catch` — a failure in one source never crashes or blocks the system. If no source yields a domain, the function returns `null` and shortening is simply skipped.

### Hostname shortening (`src/discovery/dns.ts`)

`shortHostname(hostname)` strips the trailing domain suffix only when the hostname shares the same suffix as the local machine (case-insensitive). IP addresses and `localhost` are never shortened.

### UI integration (`src/ui/onboarding.ts`)

`hostPortOf()` now calls `shortHostname()` before appending the port, so all `/crossbar` labels use shortened hostnames:

```
llama.cpp (dagobert.fritz.box:8080)
→
llama.cpp (dagobert:8080)
```

### Deduplication (`src/discovery/engine.ts`)

`dedupByHostname()` resolves any unresolved IP addresses to hostnames via `dns.reverse()` and groups servers by resolved hostname plus port. When multiple IPs map to the same hostname, only the entry with the resolved hostname is kept. This prevents duplicate rows from scanning several interfaces (Wi-Fi, Ethernet, IPv4, IPv6) on the same machine.

## Tests

- `tests/discovery/dns.test.ts` — 27 tests covering the full fallback chain, shortening behavior, IP/IPv6/localhost guards, caching, and crash resistance.
- All existing tests continue to pass.
