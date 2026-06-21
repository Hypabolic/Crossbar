# Crossbar — Capability Matrix (draft, Phase 0)

**Date:** 2026-06-21 · companion to `RESEARCH.md`. Values: ✅ yes · ◐ partial/conditional · ❌ no.
Backend endpoints are **[WEB]** — confirm live per adapter. `pi api` = which built-in Pi API type the
adapter registers under (`oai` = `openai-completions`, `ant` = `anthropic-messages`).

| Backend | port | pi api | listModels | introspectLoaded | switchModel | loadUnload | auth | health | perModelCaps | streaming | discovery fingerprint |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Ollama** | 11434 | oai | ✅ `/api/tags`,`/v1/models` | ✅ `/api/ps` | ✅ implicit (request id) | ✅ `keep_alive:0` | ◐ none local | ✅ `GET /` text | ✅ `/api/show` caps + ctx | ✅ | `GET /` → `Ollama is running` |
| **LM Studio** | 1234 | oai | ✅ `/api/v1/models` (v0 fallback) | ✅ `state` field | ✅ JIT + `/api/v1/models/load` | ✅ load/unload + `lms` | ◐ Bearer, none default | ◐ infer 200 | ✅ type+`max_context_length` | ✅ | `/api/v1/models` (v0 fallback) w/ `state`,`compatibility_type` |
| **llama-server** | 8080 | oai | ✅ `/v1/models` | ◐ `/props`,`/slots` (single) | ❌ (1/instance) | ❌ classic | ◐ none / `--api-key` | ✅ `/health` | ◐ ctx via `/props`,`meta` | ✅ | `/props` w/ `default_generation_settings`+`build_info` |
| **llama-swap** | 8080 | oai/ant | ✅ `/v1/models` (all config) | ✅ `/running` | ✅ via `model` → restart upstream | ✅ `/api/models/unload`, ttl | ◐ optional multi-scheme | ✅ `/health`→OK | ◐ via upstream | ✅ | `/` → `/ui/`; `/running`,`/upstream/{model}` |
| **vLLM** | 8000 | oai | ✅ `/v1/models` | ◐ `/is_sleeping` (dev) | ❌ base · ◐ LoRA | ◐ sleep/wake + LoRA | ◐ none / `--api-key` | ✅ `/health` | ◐ `max_model_len` only | ✅ | `/version` + `/metrics` `vllm:` + `owned_by:"vllm"` |
| **OpenAI** | cloud | oai | ✅ `/v1/models` | ❌ | ✅ (pick id) | ❌ managed | ✅ Bearer | ❌ (status page) | ❌ (static table needed) | ✅ | n/a (configured, not probed) |
| **Anthropic** | cloud | ant | ✅ `/v1/models` | ❌ | ✅ (pick id) | ❌ managed | ✅ x-api-key+version | ❌ | ✅ caps + `max_input_tokens` | ✅ | n/a |
| **TabbyAPI** | 5000 | oai | ✅ `/v1/model/list` | ✅ `/v1/model` | ✅ load | ✅ `/v1/model/{load,unload}` | ✅ x-api-key/x-admin-key | ◐ | ◐ | ✅ | `/v1/model/*` + `x-admin-key` |
| **KoboldCpp** | 5001 | oai | ✅ `/v1/models` | ✅ `/api/v1/model` | ❌ (1 GGUF) | ❌ | ◐ `--password` | ✅ `/api/extra/version` | ◐ | ✅ | `/api/extra/version`→`{"result":"KoboldCpp"}` |
| **oobabooga** | 5000 | oai | ✅ `/v1/models` | ✅ `/v1/internal/model/info` | ✅ load | ✅ `/v1/internal/model/{load,unload}` | ◐ `--api-key` | ◐ | ◐ | ✅ | `/v1/internal/*` namespace |
| **Jan** | 1337 | oai | ✅ `/v1/models` | ◐ | ◐ engine | ◐ engine | ◐ Bearer | ❌ | ◐ | ✅ | weak (log line) |
| **llamafile** | 8080 | oai | ✅ `/v1/models` | ◐ `/props` | ❌ | ❌ | ◐ `--api-key` | ✅ `/health` | ◐ via `/props` | ✅ | `/props` w/ non-`bNNNN` build_info |
| **generic OpenAI-compat** | varies | oai | ✅ `/v1/models` | ❌ | ❌ | ❌ | ◐ optional Bearer | ◐ | ◐ | ✅ | anything serving `/v1/models` (fallback) |

## Capability-driven UX rules (derived)

- **switchModel ❌** (llama-server, vLLM-base, KoboldCpp, llamafile) → hide/disable the "switch model"
  action; offer "restart server with model X" guidance only where applicable. Suggest llama-swap when a
  bare llama-server is detected (it unlocks switching).
- **introspectLoaded ❌/◐** (OpenAI, Anthropic, vLLM, llamafile) → show **last-known** selected model
  rather than a live "loaded" indicator; never claim live state we can't read.
- **perModelCaps ❌** (OpenAI) / ◐ (most local) → fall back to a maintained static capability table and
  conservative defaults (`contextWindow` from `/props`/`max_*` when present, else a safe default).
- **auth ◐** → onboarding offers a no-auth toggle; probe public metadata endpoints first, only require a
  key for inference (a `401` on `/v1/chat/completions` but `200` on `/v1/models` ⇒ "running but keyed").
- **loadUnload ✅** (Ollama, LM Studio, TabbyAPI, oobabooga, llama-swap) → expose explicit load/unload;
  elsewhere degrade to implicit-on-use (Ollama) or nothing.

## Discovery probe order (cheapest/most-specific first)

1. `GET /` → `Ollama is running` ⇒ Ollama · redirect `/ui/` ⇒ llama-swap
2. `GET /api/extra/version` → `{"result":"KoboldCpp"}` ⇒ KoboldCpp
3. `GET /api/v1/models` (v0 fallback) 200 w/ `state`/`compatibility_type` ⇒ LM Studio
4. `GET /props` w/ `default_generation_settings`+`build_info` ⇒ llama-server / llamafile
5. `GET /version` + `/metrics` `vllm:` ⇒ vLLM
6. `GET /v1/models` shape: `owned_by:"vllm"`⇒vLLM · `meta.n_ctx_train`⇒llama.cpp ·
   multiple models on :8080⇒llama-swap · `/v1/internal/*`⇒oobabooga · `/v1/model/*`⇒TabbyAPI ·
   else ⇒ generic OpenAI-compat

Default probe ports (localhost): `11434, 1234, 8080, 8000, 5000, 5001, 1337`. **No mDNS exists for any
backend** → LAN discovery, if enabled, is active port-probing across host IPs (opt-in).
