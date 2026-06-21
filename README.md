# Crossbar

[![CI](https://github.com/Hypabolic/Crossbar/actions/workflows/ci.yml/badge.svg)](https://github.com/Hypabolic/Crossbar/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hypabolic/crossbar)](https://www.npmjs.com/package/@hypabolic/crossbar)

**The local/self-hosted inference connector Pi should have shipped with.**

Crossbar is an extension for the [Pi coding agent](https://github.com/earendil-works/pi) that makes
wiring Pi to *any* local or self-hosted model backend effortless — zero hand-edited JSON, all setup
inside Pi's TUI, with auto-discovery, multi-server support, live "currently loaded" indicators, and
in-place model switching.

> Built by [Hypabolic](https://github.com/hypabolic).

---

## Why Crossbar

Existing connectors stop short: manual config files, a single server at a time, Ollama-only discovery,
or hardcoded model lists. Crossbar beats them on three axes:

1. **Widest backend support** — Ollama, LM Studio, llama.cpp, llama-swap, vLLM, OpenAI, Anthropic, plus
   a generic adapter for the OpenAI-compatible long tail (TabbyAPI, KoboldCpp, text-generation-webui,
   Jan, llamafile, …).
2. **Easiest onboarding** — `/crossbar` auto-discovers running servers on localhost and registers them.
   No JSON. API-key *and* no-auth endpoints, with a connection test before you commit.
3. **Highest-fidelity UX** — multiple simultaneous servers, a live loaded-model widget, and capability-
   driven model switching that gracefully hides what a backend can't do.

## Supported backends

| Backend | Discover | Loaded indicator | Switch model | Load/Unload | Auth |
|---|:--:|:--:|:--:|:--:|---|
| **Ollama** | ✅ | ✅ live | ✅ implicit | ✅ | none (local) |
| **LM Studio** | ✅ | ✅ live | ✅ JIT | ✅ | optional key |
| **llama.cpp** (`llama-server`) | ✅ | ✅ (single) | ❌¹ | ❌ | optional key |
| **llama-swap** | ✅ | ✅ live | ✅ proxy swap | ✅ | optional key |
| **vLLM** | ✅ | last-known | ❌¹ | ❌ | optional key |
| **OpenAI** | configured | — | pick model | — | API key |
| **Anthropic** | configured | last-known | pick model | — | API key |
| **Generic OpenAI-compatible** | ✅ (fallback) | last-known | ❌ | ❌ | optional key |

¹ Single model per instance. Run **llama-swap** in front of `llama-server`/vLLM to unlock switching —
Crossbar detects it automatically and prefers it.

Full endpoint-level detail is in [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md); research notes and
Pi-integration citations are in [`RESEARCH.md`](./RESEARCH.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Install

```bash
# from npm
pi install npm:@hypabolic/crossbar

# or from git
pi install git:github.com/hypabolic/crossbar

# or a local checkout
pi install /path/to/crossbar
```

Then start Pi and run `/crossbar`.

## Usage

- **`/crossbar`** (alias **`/local`**) — open the onboarding overlay: pick from auto-discovered servers
  or add one manually (URL + optional API key / no-auth toggle), test the connection, choose a model,
  and save.
- **Auto-discovery** runs on session start: reachable no-auth servers on localhost are registered
  automatically; keyed servers are surfaced with a prompt to add them.
- Registered models appear in Pi's standard **`/model`** picker and `/login` provider list.
- The **loaded-model widget** shows what's currently resident (`●` live via introspection, `◷` with a
  `(last-known)` suffix where a backend can't report live state).

LAN discovery (beyond localhost) is **off by default** — no backend advertises over mDNS, so Crossbar
never scans your network unless you opt in.

## How it works

- **Discovery** probes localhost ports and fingerprints each server by response shape (e.g. Ollama's
  `GET /` banner, LM Studio's `/api/v0/models` state, vLLM's `/version` + `owned_by`), preferring the
  most specific match. The generic adapter is the low-confidence fallback.
- **Registration** maps discovered models onto Pi's built-in `openai-completions` / `anthropic-messages`
  providers via `pi.registerProvider` — Crossbar writes no streaming code for OpenAI-compatible servers.
- **Persistence** keeps non-secret server metadata in `~/.pi/agent/crossbar.json`; **API keys live only
  in Pi's `auth.json`** (mode `0600`), keyed by the server's provider id, exactly like Pi's own creds.

## Security

- API keys are **never** written to `crossbar.json`, never logged, and never inlined into a provider
  config — Pi resolves them from `auth.json` at request time.
- Discovery is localhost-only by default.
- Crossbar adds no telemetry.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # vitest (conformance + unit + live-socket integration)
```

The `BackendAdapter` contract (`src/core/`) is the frozen boundary every adapter implements; the
conformance suite (`tests/conformance/`) validates every adapter against it, and
`tests/integration/` exercises the real discovery path over live sockets.

### CI / releasing

- **CI** (`.github/workflows/ci.yml`) runs `tsc --noEmit` + the full test suite on every push and PR
  (Node 22 & 24).
- **Releases** (`.github/workflows/release.yml`) publish to npm via **GitHub→npm OIDC trusted
  publishing** — no tokens or secrets. [Provenance](https://docs.npmjs.com/generating-provenance-statements)
  is attached automatically. Two ways:
  1. **Manual** — GitHub → *Actions → Release → Run workflow* → choose `patch` / `minor` / `major`.
     It bumps `package.json`, commits, tags `vX.Y.Z`, and publishes.
  2. **Tag push** — `npm version patch && git push --follow-tags` locally.

  Each release also creates a **GitHub Release** and updates [`CHANGELOG.md`](./CHANGELOG.md) — both
  generated from [Conventional Commits](https://www.conventionalcommits.org/) via
  [git-cliff](https://git-cliff.org) (`cliff.toml`). Write commit messages as `feat:`, `fix:`,
  `docs:`, `ci:`, etc. and they're grouped into the notes automatically.

  **One-time setup:** on npmjs.com, add a **Trusted Publisher** for `@hypabolic/crossbar`
  (*Package settings → Trusted Publisher → GitHub Actions*) pointing at repo **`Hypabolic/Crossbar`**
  and workflow **`release.yml`**. The workflow authenticates through the OIDC `id-token` it already
  requests — no `NPM_TOKEN` needed.

<!-- TODO: add an onboarding demo GIF (docs/onboarding.gif) recorded against a live Ollama + LM Studio. -->

## License

[MIT](./LICENSE) © Hypabolic
