# Crossbar — Architecture & Frozen Contract

**Status:** Implemented (Phases 1–3 landed) · **Date:** 2026-06-21 · Companion to `RESEARCH.md`,
`CAPABILITY-MATRIX.md`, `docs/tokens-per-second.md`. The contract under `src/core/` is the **single
source of truth**. Typechecked against Pi `0.79.9` (`tsc --noEmit` → clean).

> The sections below describe the design; everything here is now wired end-to-end (discovery, registry,
> adapters, provider shim, onboarding + manage overlay, loaded widget, and the health poll). Where a
> behaviour was once aspirational it is now live — notes call out anything still intentionally deferred.

```
discovery engine ──┐
                   ├─► server registry ──► provider shim ──► pi.registerProvider(...)
adapters[kind] ────┘         │                                         │
   (BackendAdapter)          └─► crossbar.json (metadata)              └─► models appear in /model & /login
                             secrets ─► Pi authStorage (auth.json,0600)
onboarding overlay  ─────────────────────────────────────────────────► /crossbar (alias /local)
loaded-model widget ─────────────────────────────────────────────────► ctx.ui.setStatus / setWidget
```

## 1. Module layout (Phase 2 fills these)

```
src/
  index.ts                  # extension entry: /crossbar + /local, session_start/shutdown, health poll
  poll.ts                   # per-tick health() + model refresh + re-register-on-change orchestration
  core/                     # FROZEN CONTRACT — do not change without bumping CONTRACT_VERSION
    capability.ts           # Capability enum, AuthMode, BackendKind
    types.ts                # Probe, DiscoveredServer, ModelDescriptor, LoadedState, ServerRecord, PiModelEntry
    backend-adapter.ts      # BackendAdapter interface + capability guards
    index.ts                # re-exports
  adapters/                 # one file per kind, each `implements BackendAdapter`
    ollama.ts lmstudio.ts llamacpp.ts llamaswap.ts vllm.ts
    openai.ts anthropic.ts generic.ts        # generic = openai-generic fallback
    index.ts                # ADAPTERS registry (kind → instance), probe-order export
  discovery/
    probe.ts                # Probe impl: fetch + timeout + auth-header injection + redaction
    engine.ts               # port sweep (localhost default), fingerprint dispatch, dedupe by origin
  registry/
    registry.ts             # ServerRecord CRUD, health poll, model cache, in-memory state
    persistence.ts          # crossbar.json read/write via getAgentDir(); secrets via authStorage
    ids.ts                  # stable provider-id generation (kind + host + port)
  shim/
    provider-shim.ts        # ServerRecord + ModelDescriptor[] → pi.registerProvider / unregisterProvider
  ui/
    onboarding.ts           # ctx.ui.custom overlay: discovered list + manual add + test + pick + save
    loaded-widget.ts        # setStatus/setWidget live "currently loaded" indicator
    theme.ts                # getSelectListTheme wrapper + token helpers
tests/
  conformance/              # runs EVERY adapter against the contract using fixtures
  fixtures/<kind>/          # captured HTTP responses per backend (+ edge cases)
```

## 2. BackendAdapter contract (frozen)

See `src/core/backend-adapter.ts`. Invariants every adapter MUST honour — the conformance suite checks
each one:

1. **Stateless & I/O-free.** No instance state; never call `fetch` directly — only the injected `Probe`.
2. **Honest capabilities.** An optional method (`introspectLoaded`/`switchModel`/`loadUnload`/`health`)
   is defined **iff** the matching `Capability` is in `capabilities`. Orchestrator uses the `canX`
   guards, never feature-sniffs.
3. **`fingerprint` is unauth & cheap.** Uses only public metadata endpoints; returns `null` fast for
   non-matches; sets a calibrated `confidence` (exact unique-path match → ~1.0; generic `/v1/models`
   shape → ~0.3). Cloud adapters return `null`.
4. **`listModels` filters embeddings** out of chat registration (keeps them only if flagged).
5. **`toPiModel` owns Pi mapping.** Sets `api`, `compat` quirk flags, `cost` zeros for local, and
   conservative defaults: `contextWindow` from backend or a safe fallback, `input` defaults `["text"]`.
6. **`switchModel` confirms or throws.** Must surface server-down-mid-switch and model-not-available as
   rejections, not silent success.
7. **No secret leakage.** Adapters receive `ServerCredential` but must never log/serialize `apiKey`.

`CONTRACT_VERSION = 1`. Any breaking change bumps it; registry asserts adapters match.

## 3. Provider-registration shim (`shim/provider-shim.ts`)

The ONLY bridge to Pi. For each enabled, healthy server:

```
register(record):
  adapter   = ADAPTERS[record.kind]
  cred      = resolveCredential(record)          # apiKey from authStorage, or {mode:"none"}
  models    = registry.cachedModels(record)      # from listModels, refreshed on poll
  pi.registerProvider(record.id, {
    name:    record.label,
    baseUrl: adapter.inferenceBaseUrl(server),
    apiKey:  cred.mode === "apiKey" ? `$${ENV_FOR(record.id)}` : undefined,  # see secret note
    api:     adapter.piApi,
    models:  models.map(m => adapter.toPiModel(server, m)),
  })
```

- Re-registration on model-list change = `unregisterProvider(id)` then `registerProvider(id, ...)`.
- Switching the served model updates the registered `models[]` (and the loaded widget), then
  optionally `pi.setModel(...)` to point the agent at it.
- **Secret handling:** keys are stored via `authStorage.set(record.id, {type:"api_key", key})`. The shim
  passes the key to Pi using Pi's own indirection (env/`!cmd`/literal) — never inlining the plaintext
  into long-lived structures. Exact mechanism (env handoff vs literal at register time) is the first
  thing Phase 2 verifies against `auth-storage.ts`; default to letting Pi resolve from `auth.json`.

## 4. Server registry & persistence

- **State:** `ServerRecord[]` in memory; mirror to `getAgentDir()/crossbar.json` (`CrossbarConfigFile`,
  `version:1`). Non-secret only — never write `apiKey` here.
- **Secrets:** `ctx.modelRegistry.authStorage` (`auth.json`, `0600`), keyed by `record.id`.
- **IDs:** stable, derived from `kind + host + port` (e.g. `crossbar-ollama-localhost-11434`) so a server
  keeps its id and key across restarts. (`registry/ids.ts`)
- **Health poll (`poll.ts`):** interval loop started in `session_start` (UI sessions only, so a
  long-lived timer never keeps a one-shot/headless run alive), stopped in `session_shutdown`. Each tick
  per enabled server: call `adapter.health()` and record the state (`registry.setHealth`), refresh the
  model list, and **re-register only when the model set changed** (`reRegisterServer`). The loaded widget
  persists each live introspection into the cache so the `last-known` fallback has data when a server
  drops offline, and renders a degraded/unreachable/auth indicator from the polled health.
- **Two-phase startup:** async factory (`src/index.ts`) calls `preloadCachedProviders` first (before
  Pi resolves any models) to register enabled servers that have a `lastKnownModels` cache using the
  pure `buildProviderConfig` path (`registerCachedServer`). No network, no UI, no timers, never throws.
  `session_start` then builds the live `ServerRegistry`, does refresh + auto-discovery + widget + poll.
  `catalogueChanged` + `setLastKnownModels` (which calls flush) ensure registration-relevant catalogue
  updates are durable; `updateHealthCache` remains ephemeral.
- **Lifecycle:** each fresh extension instance (startup /reload /new /resume /fork) runs the factory
  and preloads from `crossbar.json`. `session_start` → load `crossbar.json` (+ `settings`) → live
  refresh/register of enabled + auto-discovery → widget + poll (UI). `session_shutdown` → stop poll,
  unregister providers (best-effort), dispose widget. Shutdown unregs + replacement factory preload
  (by stable id) ensures replacement runtimes are not left without cached providers.
- **Persistence:** `setLastKnownModels` (manual add at save time, auto-disc first reg, startup
  refresh on change, poll changed branch) + atomic rename in `saveConfig`. Never persists health or
  `lastSeenAt`.

## 5. Discovery engine (`discovery/`)

- **Default scope: localhost only.** Probe ports `[11434,1234,8080,8000,5000,5001,1337]` on `127.0.0.1`
  (override with `CrossbarSettings.probePorts`). LAN probing is opt-in and **wired**: set
  `CrossbarSettings.lanDiscovery: true`. With no `lanHosts`, `discover()` **auto-detects the host's own
  private subnet(s)** via `localSubnetCidrs()` (`src/discovery/subnet.ts`, reads `os.networkInterfaces()`
  at runtime — RFC1918 only, `/22` or smaller; never hardcoded) and sweeps them. Explicit `lanHosts`
  override; each entry may be a host, CIDR (`10.0.1.0/24`), or last-octet range (`10.0.1.10-50`),
  expanded by `expandHosts()` (capped at 1024). `discoverLan` probes `hosts × probePorts` with a worker
  pool (`runBounded`): a high `concurrency` (128), short timeout (400 ms), and a `livenessFirst` gate —
  one cheap probe per address skips the full adapter fan-out on dead IPs, so a dead origin costs a single
  socket. A full `/24` (~1778 origins) drops from ~44 s to ~3 s. Results merge/de-dupe into localhost — no mDNS.
  `CrossbarSettings` is **owned by `ServerRegistry`** (loaded from / persisted to `crossbar.json` on
  every mutation, so a server add/toggle never clobbers it) and editable from `/crossbar → ⚙ Discovery
  settings`. `discover()` reads `registry.getSettings()` at call time, so edits apply on the next scan.
- **Dismissed servers:** at the no-chat-models dead-end (e.g. a reachable Ollama with only embedding
  models — no chat models to add, and not in the registry to remove) the user picks one of two flavours.
  *Hide for this session* is in-memory only (a `Set` in `openOnboarding`, not persisted) — the server
  returns next launch. *Dismiss permanently* writes the normalised base URL to `CrossbarSettings.dismissed`;
  `discover()` filters those out for **both** `/crossbar` and startup auto-register, so they stop
  reappearing on every scan. Restore permanent dismissals under `⚙ Discovery settings → Dismissed servers`.
- **Per origin:** run the probe-order fingerprint chain (CAPABILITY-MATRIX §"probe order"); pick the
  highest-confidence adapter; fall back to `openai-generic` when only `/v1/models` matches.
- **Short timeouts** (e.g. 600ms) and bounded concurrency; a refused port returns `status:0` fast.
- **Key-vs-no-auth:** probe public metadata first; a `401` on `/v1/chat/completions` with `200` on
  `/v1/models` ⇒ "running but keyed" → onboarding prompts for a key.

## 6. Onboarding flow (`ui/onboarding.ts`) — `/crossbar`

Overlay via `ctx.ui.custom<T>(factory, { overlay:true, overlayOptions })` using `SelectList` +
`Container`/`Text`/`DynamicBorder`, themed with `getSelectListTheme` / `theme.fg`:

```
/crossbar →
  [Discovered]   Ollama (localhost:11434)  ✓ healthy
                 LM Studio (localhost:1234) (added)
  [Registered]   vLLM (192.168.1.5:8000)   (added · not discovered)   ← offline servers stay manageable
  [Disabled]     llama.cpp (192.168.1.9:8080) (disabled)              ← can be re-enabled
  [Rescan]       ⟳ Rescan for servers
  [Manual add]   + Add server…  → input URL → optional API key (no-auth toggle) → Test connection
  → new server:  fingerprint → listModels → optional "select in Pi" → save + register immediately
  → added server: persistent Manage overlay (capability-filtered) → Back/Esc returns to server list
```

- **New server** path: fingerprint → list chat models → optionally select the current Pi model →
  save and register immediately.
- **Already-registered** path opens the **Manage overlay** (`buildManageItems` → `capabilityActions`):
  switch / load / unload / loaded-model detail view (capability-gated) · **enable/disable** (toggles
  registration without forgetting the server) · **remove** (unregisters + deletes the key) · **Back**.
  Disabled servers hide operational actions until re-enabled. Capability-less backends show only
  enable/disable + remove + Back.
- Capability-driven: actions are hidden via the `canSwitch`/`canLoadUnload`/`canIntrospect` guards.
- Test-connection uses the same `Probe` + adapter `health`/`listModels` as production.
- Cloud keys (OpenAI/Anthropic) can still be entered via stock `/login`; Crossbar's registered models
  surface in `/model` regardless.

## 7. Loaded-model widget (`ui/loaded-widget.ts`)

- `ctx.ui.setStatus("crossbar-loaded", …)`, refreshed by the health poll and on `model_select`.
- Live introspection renders `● <server>:<model>`; the snapshot is persisted to the cache so a later
  drop shows `◷ <server>:<model> (last-known)` instead of going blank.
- When `!supports(IntrospectLoaded)` (OpenAI, Anthropic, vLLM, llamafile) → show **last-known** from
  `ServerRecord.lastKnownLoaded`; never claim live state we can't read (`source` field).
- Unhealthy servers render `✕ <server>:unreachable|degraded|auth` from the polled `HealthState`,
  taking precedence over a stale loaded list.

> **Tokens/sec:** not shown. The provider-reported decode rate (LM Studio `stats.tokens_per_second`,
> llama.cpp `timings.predicted_per_second`, Ollama `eval_*`) is **not reachable** from an extension —
> Pi is the inference client and its parser drops those non-standard fields. See
> `docs/tokens-per-second.md` for the upstream-Pi change that would surface it.

## 8. Conformance suite (`tests/conformance/`)

One parameterized suite (`run-conformance.ts`) runs against **every** adapter using a fake `Probe`
(`fake-probe.ts`) backed by per-adapter fixtures (`tests/adapters/<kind>.fixture.ts`). Required cases:

- fingerprint: positive, negative (other backend's response), ambiguous-port disambiguation.
- listModels: normal, empty, embeddings filtered, missing-caps defaults applied.
- introspectLoaded / switchModel / loadUnload: present ⇔ capability; success + edge cases —
  **auth failure (401), server-down-mid-switch, model-not-loaded, streaming cutoff**.
- toPiModel: output validates against Pi's `ProviderConfig["models"]` element shape (compile + runtime).
- capability honesty: every optional method present ⇔ its `Capability` is declared.

Discovery validated on **zero / one / many** servers (Phase 3 hardening).

## 9. Build history (all landed)

- **Wave A:** conformance harness + fixtures · discovery engine + probe · registry + persistence + id gen.
- **Wave B (one adapter per kind):** ollama · lmstudio · llamacpp · llamaswap · vllm · openai · anthropic ·
  generic — each with fixtures, green against conformance.
- **Wave C:** provider shim + `/crossbar` onboarding/manage overlay + loaded widget.
- **Orchestration:** `poll.ts` health/model-refresh loop, last-known-loaded caching, LAN discovery,
  enable/disable, shutdown unregistration.

### Deferred / not built
- **Tokens/sec display** — blocked on upstream Pi (see `docs/tokens-per-second.md`).
- **Per-model caps** for LM Studio / llama.cpp / vLLM are largely defaulted (those APIs don't expose
  reasoning/tools/max-output); only context + vision are derived where available.
- **Live VRAM/TTL display** — `LoadedModelInfo.vramBytes`/`expiresAt` are collected by introspection but
  not yet surfaced in the widget.
