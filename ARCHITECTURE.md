# Crossbar — Architecture & Frozen Contract (Phase 1)

**Status:** Interface frozen pending sign-off · **Date:** 2026-06-21 · Companion to `RESEARCH.md`,
`CAPABILITY-MATRIX.md`. The contract under `src/core/` is the **single source of truth**. Phase 2
fan-out targets it and nothing else. Typechecked against Pi `0.79.9` (`tsc --noEmit` → clean).

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
  index.ts                  # extension entry: registers /crossbar, wires session_start (STUB today)
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
- **Health poll:** interval loop started in `session_start`, stopped in `session_shutdown` (per Pi's
  long-lived-resource rule). Updates health, refreshes model cache, drives the loaded widget. On
  `unreachable`, keep the registration but mark degraded; show last-known models/loaded.
- **Lifecycle:** `session_start` → load `crossbar.json` → (if enabled) run auto-discovery →
  register all enabled+reachable servers → start poll. `session_shutdown` → stop poll.

## 5. Discovery engine (`discovery/`)

- **Default scope: localhost only.** Probe ports `[11434,1234,8080,8000,5000,5001,1337]` on `127.0.0.1`.
  LAN host-range probing is opt-in via `CrossbarSettings.lanDiscovery` (no mDNS exists for any backend).
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
  [Discovered]  Ollama (localhost:11434)  ✓ healthy
                LM Studio (localhost:1234) ✓ healthy
  [Manual add]  + Add server…  → input URL → optional API key (no-auth toggle) → Test connection
  → on select/add: fingerprint → health → listModels → pick default model → save (registry + auth.json)
```

- Capability-driven: hide "switch model" when `!supports(SwitchModel)`; show load/unload only when
  `LoadUnload`; show a no-auth toggle always, key entry only when needed.
- Test-connection uses the same `Probe` + adapter `health`/`listModels` as production.
- Cloud keys (OpenAI/Anthropic) can still be entered via stock `/login`; Crossbar's registered models
  surface in `/model` regardless.

## 7. Loaded-model widget (`ui/loaded-widget.ts`)

- `ctx.ui.setStatus("crossbar-loaded", theme.fg("accent", "● <server>:<model>"))`, refreshed from the
  health poll's `introspectLoaded` and from the `model_select` event.
- When `!supports(IntrospectLoaded)` (OpenAI, Anthropic, vLLM, llamafile) → show **last-known**
  selection from `ServerRecord.lastKnownLoaded`; never claim live state we can't read (`source` field).

## 8. Conformance suite (`tests/conformance/`)

One parameterized suite runs against **every** adapter using a fake `Probe` backed by per-backend
fixtures. Required cases:

- fingerprint: positive, negative (other backend's response), ambiguous-port disambiguation.
- listModels: normal, empty, embeddings filtered, missing-caps defaults applied.
- introspectLoaded / switchModel / loadUnload: present ⇔ capability; success + edge cases —
  **auth failure (401), server-down-mid-switch, model-not-loaded, streaming cutoff**.
- toPiModel: output validates against Pi's `ProviderConfig["models"]` element shape (compile + runtime).
- capability honesty: every optional method present ⇔ its `Capability` is declared.

Discovery validated on **zero / one / many** servers (Phase 3 hardening).

## 9. Phase 2 waves (contract-driven fan-out — nothing starts before sign-off)

- **Wave A (parallel):** conformance harness + fixtures · discovery engine + probe · registry +
  persistence + id gen.
- **Wave B (parallel, one adapter per agent):** ollama · lmstudio · llamacpp+llamaswap · vllm ·
  openai+anthropic · generic. Each lands with its fixtures and passes conformance before merge.
- **Wave C:** provider shim + `/crossbar` onboarding overlay + loaded widget; full integration; green
  conformance across all adapters.

After each wave: reconvene, integrate, run conformance against every adapter.
