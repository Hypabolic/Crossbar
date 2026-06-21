# Crossbar — Phase 0 Research

**Status:** Draft for sign-off · **Date:** 2026-06-21 · **Author:** Crossbar orchestrator (Hypabolic)

Crossbar is a Pi coding-agent extension: the local/self-hosted inference connector Pi should
have shipped with. This document records the *verified* facts that the `BackendAdapter` contract
(Phase 1) will be built on. **No interface or adapter code is written until this is signed off.**

Two evidence tiers are used:

- **[PI]** — read from the real `earendil-works/pi` (`badlogic/pi-mono`) source at commit `d93b92b`,
  cloned to `.pi-reference/` (gitignored). Cited as `file:line`. Treat as authoritative.
- **[WEB]** — backend HTTP APIs gathered from official docs/source, June 2026. Endpoints drift;
  every adapter must confirm against a live instance. Cited by URL in the backend tables below.

---

## 1. Executive summary — what makes Crossbar buildable (and how it wins)

1. **Pi already exposes a first-class provider API to extensions.** `pi.registerProvider(name, config)`
   takes a `baseUrl`, `apiKey`, an `api` type, and a list of models with full capability metadata.
   The built-in `api: "openai-completions"` covers the *entire* OpenAI-compatible tail
   (Ollama, LM Studio, vLLM, llama.cpp, TabbyAPI, KoboldCpp, oobabooga, Jan, llamafile);
   `anthropic-messages` covers Anthropic. **Crossbar writes zero streaming code** for these. [PI]
2. **The hard, unsolved problems — the ones every existing connector punts on — are *discovery*,
   *loaded-model introspection*, *model switching*, and *in-TUI onboarding*.** Pi does none of these.
   That is exactly where Crossbar's `BackendAdapter` earns its keep.
3. **`/login` is a builtin and cannot be hooked.** Crossbar's onboarding therefore lives in its own
   command (proposed `/crossbar`), while every backend Crossbar registers *also* shows up in the
   stock `/login` selector automatically. (Design decision — see §4 and the sign-off questions.) [PI]
4. **No backend advertises over mDNS/zeroconf.** Discovery = active localhost port-probe + response
   fingerprinting. A clean, fast probe matrix is a core deliverable. [WEB]
5. **Prior art is uniformly single-backend.** The closest, `v2nic/pi-ollama-provider`, is Ollama-only
   with no cross-backend switch. Crossbar's multi-backend probe + capability-driven hot-swap is novel
   in the Pi ecosystem. [WEB]

---

## 2. Pi integration surface (authoritative — read from source) [PI]

### 2.1 Extension lifecycle

- Entry point: `export default function (pi: ExtensionAPI): void | Promise<void>`
  — `core/extensions/types.ts:1416` (`ExtensionFactory`). Async factories are awaited before
  `session_start` flushes, so async auto-discovery at startup is supported. (`docs/extensions.md:182`)
- **Do not** start long-lived resources in the factory (it may run with no session). Defer to
  `session_start`; clean up in `session_shutdown`. (`docs/extensions.md:219`)
- Auto-loaded from `~/.pi/agent/extensions/*.ts` and `.pi/extensions/*.ts`, or via a package listed
  in `settings.json` `packages`. (`docs/extensions.md:108`)
- Relevant registration APIs on `pi` (`core/extensions/types.ts:1120-1385`):
  - `registerCommand(name, { description?, getArgumentCompletions?, handler })`
  - `registerShortcut(keyId, { description?, handler })`
  - `registerTool(toolDef)` · `registerFlag(name, opts)` · `getFlag(name)`
  - `registerProvider(name, config)` · `unregisterProvider(name)`  ← **core to Crossbar**
  - `setModel(model)` · `getThinkingLevel()` / `setThinkingLevel()`
  - `events` (shared `EventBus` for cross-extension comms)
- Relevant events (`pi.on(...)`): `session_start` (`reason: startup|reload|new|resume|fork`),
  `session_shutdown`, `model_select`, `before_agent_start`, `project_trust`, `input`, `tool_call`,
  `tool_result`. (`docs/extensions.md:274-879`)

### 2.2 Provider & model registration — the central contract

`pi.registerProvider(name, config)` where `config` is `ProviderConfigInput`
(`core/model-registry.ts:968-992`, `docs/custom-provider.md`):

```ts
interface ProviderConfigInput {
  name?: string;              // display name (appears in /login + /model)
  baseUrl?: string;
  apiKey?: string;            // "$ENV" | "${A}_${B}" | "!shell-cmd" | literal | "$$lit" | "$!lit"
  api?: Api;                  // "openai-completions" | "anthropic-messages" | "openai-responses" | ...
  headers?: Record<string,string>;
  authHeader?: boolean;       // adds Authorization: Bearer
  streamSimple?: (model, context, opts?) => AssistantMessageEventStream;  // only for novel APIs
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<{
    id: string; name: string;
    api?: Api; baseUrl?: string;            // per-model override of provider defaults
    reasoning: boolean;                      // supports extended thinking
    thinkingLevelMap?: { minimal?: string|null; low?: ...; medium?: ...; high?: ...; xhigh?: ... };
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };  // 0s for local
    contextWindow: number;                   // tokens
    maxTokens: number;                       // max output tokens
    headers?: Record<string,string>;
    compat?: OpenAICompletionsCompat;        // per-backend quirk flags (see below)
  }>;
}
```

- Known API types: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `mistral-conversations`, `google-generative-ai`, `google-vertex`, `bedrock-converse-stream`,
  `azure-openai-responses`, `openai-codex-responses` (`packages/ai/src/types.ts:6-15`).
- `OpenAICompletionsCompat` (`packages/ai/src/types.ts:396-443`) carries the quirk flags that let one
  API type serve many backends: `maxTokensField: "max_completion_tokens"|"max_tokens"`,
  `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`,
  `thinkingFormat: "openai"|"openrouter"|"deepseek"|"qwen"|"qwen-chat-template"|"chat-template"|...`,
  `requiresToolResultName`, `cacheControlFormat`, etc. **Per-backend tuning of these flags is part of
  each adapter's job.**
- The agent loop surfaces registered models via the `ModelRegistry`
  (`getAll()`, `getAvailable()`, `hasConfiguredAuth()`, `find()` — `core/model-registry.ts:352-373`),
  the `/model` command (re-reads on open), and `pi --list-models` (`cli/list-models.ts`).
- `docs/custom-provider.md` documents the exact dynamic-discovery pattern Crossbar uses: async factory
  → `fetch(baseUrl + "/v1/models")` → `registerProvider(...)` with discovered models.
- **Implication for the contract:** Pi-registration is *shared plumbing* — a thin map from a discovered
  server + model list onto `registerProvider`. The differentiating verbs (`introspectLoaded`,
  `switchModel`, `loadUnload`, `health`) are backend-specific HTTP and belong on the adapter.

### 2.3 Credential & config persistence

- **Credentials:** `~/.pi/agent/auth.json`, file mode `0600`, dir `0700`, enforced on every write;
  file-locked against concurrent instances (`core/auth-storage.ts:49-160`; path `config.ts:520`).
  Public API via `ctx.modelRegistry.authStorage`: `set(provider, cred)`, `get`, `remove`, `list`,
  `getApiKey(provider)`, `getAuthStatus`. Credential shapes:
  `{ type: "api_key", key, env? }` or `{ type: "oauth", access, refresh, expires, ... }`
  (`core/auth-storage.ts:24-36`).
- **No per-extension settings namespace.** `appendEntry` is **session-scoped only** — unsuitable for a
  durable multi-server registry (`docs/extensions.md:1702`).
- **Crossbar's persistence model (proposed):**
  - Non-secret server metadata (url, kind, label, last-known models, enabled) →
    a dedicated `~/.pi/agent/crossbar.json`, located via the exported `getAgentDir()`.
  - Secrets → `auth.json` via `authStorage.set(providerId, { type: "api_key", key })`, keyed by a
    Crossbar-generated stable provider id. This stores keys exactly the way Pi does, with `0600` perms.
- Key resolution order: CLI `--api-key` → `auth.json` → env var (`packages/ai/src/env-api-keys.ts`) →
  custom fallback (`core/auth-storage.ts:464-534`).

### 2.4 TUI primitives & theme

- Onboarding overlay: `ctx.ui.custom<T>(factory, { overlay: true, overlayOptions })` returns a Promise
  resolved by a `done(result)` callback (`core/extensions/types.ts:124-275`). `overlayOptions`:
  `width`/`maxHeight` (number or `"60%"`), `anchor`, `offsetX/Y`, `margin` (`packages/tui/src/tui.ts:171`).
- Components: `SelectList(items: SelectItem[], maxVisible, theme, layout?)` with
  `SelectItem { value, label, description? }`, `onSelect`/`onCancel`/`onSelectionChange`, `setFilter`
  (`packages/tui/src/components/select-list.ts:40-138`); plus `Container`, `Text`, `Spacer`, `Box`,
  `DynamicBorder` (`packages/tui/src/tui.ts`, `.../components/dynamic-border.ts`).
- Custom component contract: object with `render(width): string[]`, `invalidate()`, `handleInput(data)`;
  call `tui.requestRender()` after state changes. Key matching via `matchesKey(data, Key.up|down|enter|escape)`
  (`packages/tui/src/keys.ts`).
- Simpler prompts without a custom component: `ctx.ui.select(title, string[])`,
  `ctx.ui.confirm(title, msg)`, `ctx.ui.input(title, placeholder?)`, `ctx.ui.notify(msg, type)`.
- **Live "currently loaded" widget:** `ctx.ui.setStatus(key, text)` (footer) and
  `ctx.ui.setWidget(key, lines|factory, { placement: "aboveEditor"|"belowEditor" })`. Update from the
  `model_select` event and from Crossbar's health/introspection poll. Pattern proven in
  `examples/extensions/model-status.ts:12-31` and `status-line.ts:14-32`.
- **Theme tokens only — never raw ANSI.** `theme.fg(token, text)`, `theme.bg(token, text)`,
  `theme.bold/italic/underline`. Tokens include `text accent muted dim success error warning border
  borderAccent selectedBg ...` (`modes/interactive/theme/theme.ts:107-160`). Re-apply styles per line;
  rebuild styled strings in `invalidate()` so theme switches take effect.

### 2.5 Trust / security model

- Extensions run **unsandboxed** with the user's full permissions; project-trust gates *loading*, not
  execution (`docs/security.md`). Reaching `localhost:*` needs no special permission → probing is fine.
- **No automatic key redaction anywhere.** Crossbar must never log API keys, never echo them in
  notifications, and never write them outside `auth.json`. (Hard rule.)

### 2.6 Packaging

- Package manifest declares `"pi": { "extensions": ["./..."] }`; install via
  `pi install npm:@hypabolic/crossbar@<ver>` / `git:` / local path (`docs/packages.md`).
- **Deps must be exact-pinned** — `scripts/check-pinned-deps.mjs` rejects `^`/`~`.
- Peer deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.
- **`@hypabolic` npm scope is empty/available** (`@hypabolic/crossbar` → 404); unscoped `crossbar`
  is taken → publish as **`@hypabolic/crossbar`**. (Verified against npm registry 2026-06-21.)

---

## 3. Backend HTTP APIs [WEB — verify live per adapter]

Ports, list/introspect/switch endpoints, auth, and a discovery fingerprint per backend. Full source
URLs are in the per-stream notes; the most load-bearing facts:

### 3.1 Ollama — `:11434`
- List `GET /api/tags` + OpenAI `GET /v1/models`. Loaded: **`GET /api/ps`** (`expires_at`, `size_vram`).
- Caps: `POST /api/show` → `capabilities[]` (`completion vision tools embedding thinking`) +
  `model_info.<arch>.context_length`.
- Switch: **implicit** — request a different model id; it loads on demand. Unload: `keep_alive: 0`.
- Health `GET /` → `"Ollama is running"`. Version `GET /api/version`. Auth: none local.
- **Fingerprint:** `GET /` body `Ollama is running`.

### 3.2 LM Studio — `:1234`
- OpenAI `/v1/*` **plus** richer `GET /api/v0/models` → per-model `state: "loaded"|"not-loaded"`,
  `type: llm|vlm|embeddings`, `max_context_length`, `loaded_context_length`, `quantization`, `arch`.
  (v0.4.0+ also has `/api/v1/*`.)
- Switch/load: JIT on request; explicit `POST /api/v1/models/load` / `/unload`; `lms` CLI. TTL auto-evict.
- No dedicated `/health` or `/version` (infer from `/api/v0/models` 200). Auth: Bearer, none by default.
- **Fingerprint:** `GET /api/v0/models` 200 with `state`/`compatibility_type`.

### 3.3 llama.cpp `llama-server` — `:8080` (single model per instance)
- `GET /v1/models` (+ non-standard `meta.n_ctx_train`), `GET /props`
  (`default_generation_settings.n_ctx`, `model_path`, `build_info`, `modalities`), `GET /slots`,
  `GET /health` → `{"status":"ok"}`. Auth: none / `--api-key` (Bearer; `/health`+`/v1/models` stay public).
- **No hot-swap** in classic deployments (model fixed at launch with `-m`). (master adds a router mode.)
- **Fingerprint:** `GET /props` with `default_generation_settings` + `build_info`.

### 3.4 llama-swap — `:8080` (proxy; enables switching for llama.cpp et al.)
- Repo **`mostlygeek/llama-swap`**, default `:8080` (**not** 8081). OpenAI + Anthropic compatible front door.
- `GET /v1/models` aggregates all YAML-configured models; **`GET /running`**, `GET /upstream/{model}`,
  `POST /api/models/unload[/{id}]`, `GET /api/events` (SSE), `GET /health` → `OK`, dashboard at `/ui`.
- Switch: request a `model` id → starts that upstream, **stops the current one** (single-at-a-time by
  default), proxies. Idle unload via `ttl`/`globalTTL`. Auth: optional `apiKeys` (Basic/Bearer/x-api-key).
- **Fingerprint:** `/` redirects to `/ui/`; llama-swap-only paths `/running`, `/upstream/{model}`;
  multiple models on `:8080`.

### 3.5 vLLM — `:8000` (single served model)
- `GET /v1/models` → `ModelCard { id, max_model_len, owned_by:"vllm", root, parent }`.
  `GET /health`, `GET /version` → `{"version":...}` (both unauth even when keyed).
- **No base-model hot-swap.** Runtime: Sleep/Wake (`/sleep`,`/wake_up`,`/is_sleeping`, dev mode) and
  dynamic LoRA (`/v1/load_lora_adapter`, `/unload_lora_adapter`). Auth: `--api-key` (Bearer; guards `/v1` only).
- **Fingerprint:** `GET /version` + `/metrics` with `vllm:`-prefixed metrics + `owned_by:"vllm"`.

### 3.6 OpenAI cloud — `https://api.openai.com/v1`
- `GET /v1/models` (id/object/created/owned_by — **no per-model caps**). Bearer auth. No `/health`.
  Crossbar must carry its own static capability table for known OpenAI model families.

### 3.7 Anthropic cloud — `https://api.anthropic.com/v1`
- `GET /v1/models` **exists** → `{ id, display_name, capabilities{image_input,pdf_input,thinking,...},
  max_input_tokens, max_tokens }` (verify live: doc sample showed `0` token fields).
  Headers: `x-api-key` + `anthropic-version: 2023-06-01`. Use built-in `api: "anthropic-messages"`.

### 3.8 Generic OpenAI-compatible tail
| Backend | Port | Load/unload API | Auth | Fingerprint |
|---|---|---|---|---|
| TabbyAPI | 5000 | `POST /v1/model/{load,unload}` | `x-api-key` + **`x-admin-key`** | `/v1/model/*` family + `x-admin-key` |
| KoboldCpp | 5001 | none (single GGUF) | `--password` Bearer | `GET /api/extra/version` → `{"result":"KoboldCpp"}` |
| oobabooga | 5000 | `POST /v1/internal/model/{load,unload}` | `--api-key` Bearer | `/v1/internal/*` namespace |
| Jan | 1337 | engine-managed | Bearer | weak; log line only |
| llamafile | 8080 | none | `--api-key` | `/props` like llama-server; non-`bNNNN` build_info |

One **generic OpenAI-compatible adapter** (fingerprint anything serving `/v1/models`) covers this tail;
TabbyAPI/oobabooga get optional load/unload upgrades when their admin paths are detected.

---

## 4. The `/login` constraint → onboarding design

`/login` is a builtin and exposes **no extension hook** (`core/slash-commands.ts:34`;
`modes/interactive/.../login-dialog.ts`). Two facts shape the design:

1. Any provider Crossbar registers (with `apiKey`/`oauth`) **appears in the stock `/login` selector
   automatically** — so cloud keys (OpenAI/Anthropic) entered via `/login` "just work" for Crossbar's
   registered models.
2. The rich part of the mission — auto-discovered local servers, no-auth toggle, test-connection,
   model pick, live switching — **cannot be injected into `/login`** and must be Crossbar's own command.

**Proposed:** a `/crossbar` command (alias `/local`) that opens the discovery/onboarding overlay, plus
auto-discovery on `session_start` that registers found servers (which then also surface in `/login` and
`/model`). This honours the mission's intent ("configuration happens inside Pi's TUI, zero hand-edited
JSON") within Pi's actual extension surface. **Confirm at sign-off.**

---

## 5. Prior art & how Crossbar surpasses it [WEB]

| Extension | Scope | Stops at |
|---|---|---|
| `v2nic/pi-ollama-provider` (closest) | Ollama only | no LM Studio/llama.cpp/vLLM; no cross-backend switch; no presets |
| `CaptCanadaMan/pi-ollama` | Ollama only | native chat fix only; no switch UI |
| `woolst/pi-ollama-capabilities` | Ollama only | **manual** capability maps, no live introspection |
| `fgrehm/pi-ollama-cloud` | Ollama cloud only | no local backends |
| `aliou/pi-synthetic` | one cloud API | models hardcoded, no discovery |

Every one is single-backend or hardcoded. **None probes multiple local engines in one connector, none
does cross-backend runtime switching, and the only "loadout" tool needs hand-authored capability maps.**
Crossbar's multi-backend probe + live introspection + capability-driven switch is new in the Pi
ecosystem. (Multi-backend probing exists only in non-Pi apps.)

---

## 6. Draft `BackendAdapter` contract (sketch — to be locked in Phase 1, NOT yet code)

Shown so sign-off can react to the shape. Names/signatures are provisional.

```ts
enum Capability {
  ListModels, IntrospectLoaded, SwitchModel, LoadUnload, Health, PerModelCaps, Streaming,
}
type AuthMode = "none" | "apiKey";

interface DiscoveredServer { kind: BackendKind; baseUrl: string; auth: AuthMode; version?: string; }
interface ModelDescriptor {       // maps onto registerProvider's model[] entry
  id: string; name: string;
  contextWindow?: number; maxTokens?: number;
  input: ("text"|"image")[]; reasoning?: boolean;
  tools?: boolean; embeddings?: boolean;
  compat?: OpenAICompletionsCompat;
}
interface LoadedState { loadedModelIds: string[]; perModel?: Record<string, {vram?: number; expiresAt?: number}>; }

interface BackendAdapter {
  readonly kind: BackendKind;
  readonly capabilities: ReadonlySet<Capability>;
  readonly piApi: "openai-completions" | "anthropic-messages";   // which built-in to register under

  fingerprint(baseUrl: string, probe: Probe): Promise<DiscoveredServer | null>;  // discovery
  health(server: DiscoveredServer): Promise<HealthStatus>;
  listModels(server, auth): Promise<ModelDescriptor[]>;
  introspectLoaded?(server, auth): Promise<LoadedState>;          // gated by IntrospectLoaded
  switchModel?(server, auth, modelId): Promise<void>;             // gated by SwitchModel
  loadUnload?(server, auth, modelId, action): Promise<void>;      // gated by LoadUnload
}
```

Cross-cutting (orchestrator-owned, not per-adapter): the discovery engine, the server registry +
persistence, the provider-registration shim onto `pi.registerProvider`, the onboarding overlay, the
loaded-model widget, and capability-driven rendering (hide "switch" when unsupported, show last-known
loaded model when introspection is absent).

---

## 7. Decisions (signed off 2026-06-21)

1. **Onboarding entry point** — ✅ `/crossbar` command (alias `/local`) + `session_start`
   auto-discovery. Registered backends also appear in stock `/login`/`/model`. (§4)
2. **v1 backend scope** — ✅ full set: first-class adapters for Ollama, LM Studio, llama.cpp,
   llama-swap, vLLM, OpenAI, Anthropic **+** one generic OpenAI-compat adapter (covers TabbyAPI/
   KoboldCpp/oobabooga/Jan/llamafile; the first three get optional load/unload upgrades when their
   admin paths are fingerprinted).
3. **Discovery default** — ✅ localhost-only by default; LAN host-range probing is explicit opt-in
   (no mDNS exists for any backend; unsolicited LAN scanning is intrusive).
4. **Secret storage** — ✅ Pi-native split: secrets in `auth.json` via `authStorage` (`0600`, keyed by
   a Crossbar-generated stable provider id); non-secret server metadata in `~/.pi/agent/crossbar.json`
   via `getAgentDir()`. (§2.3)

---

## 8. Risks & unverified items

- **[WEB] all backend endpoints** need live confirmation per adapter; HTTP `Server:` headers were not
  captured from live instances — prefer JSON-shape/unique-path fingerprints over headers.
- **Ollama** exact context key `<arch>.context_length` inferred from convention — verify on `/api/show`.
- **LM Studio** `loaded_context_length` and lack of `/health`/`/version` inferred — verify.
- **llama-server router/multi-model** mode is evolving on master (build-date dependent).
- **Anthropic `/v1/models`** token fields showed `0` in the doc sample — confirm real values live.
- **OpenAI** exposes no per-model caps → Crossbar needs a maintained static table for OpenAI families.
- **[PI] `registerProvider` in the published npm build:** verified in source at `d93b92b`; confirm the
  exact signature exists in the pinned published version Crossbar will depend on before locking Phase 1.
- Prior-art limitations taken from READMEs, not source; `awesome-pi-agent` list is archived (entries
  recovered from git history) — treat the prior-art survey as directional.

---

*Companion file:* `CAPABILITY-MATRIX.md` (backend × capability, with endpoints).
