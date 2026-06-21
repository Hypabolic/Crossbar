# Tokens/sec — why it isn't shown, and what would make it possible

LM Studio's and llama.cpp's own chat UIs show a decode tokens/sec figure. Crossbar does **not**, and
this note explains why and records the upstream change that would unblock it.

## Why Crossbar can't show the provider's number today

Crossbar is a **connector**, not the inference client. It discovers a backend and registers its base URL
with Pi via `pi.registerProvider(...)`. From then on **Pi** sends `/v1/chat/completions` directly to the
backend and consumes the response itself — Crossbar is never in the request/response path and never sees
the response body.

The backends *do* report decode speed (or the timing to derive it) in their responses:

| Backend | Field in the response body |
|---|---|
| LM Studio | `stats.tokens_per_second`, `stats.time_to_first_token`, `stats.generation_time` |
| llama.cpp (`llama-server`) | `timings.predicted_per_second`, `timings.predicted_n`, `timings.predicted_ms` |
| Ollama (native API) | `eval_count`, `eval_duration` → `eval_count / (eval_duration / 1e9)` |

…but **Pi's OpenAI-completions parser keeps only the standard fields** (`choices`, `usage`, `id`,
`model`) and discards everything else (`@earendil-works/pi-ai`, `providers/openai-completions.js` —
`parseChunkUsage` reads `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`
only). The extension-facing surface confirms there is no hook to recover it:

- `after_provider_response` → `{ status, headers }` only (no body).
- `message_end` / `turn_end` → an `AssistantMessage` whose `usage` is token **counts** plus a single
  `timestamp`; no provider timing, no `stats`/`timings` passthrough.
- `AssistantMessageDiagnostic` is error-only.

So the genuine, provider-reported tokens/sec is **unreachable** from a Crossbar extension. (A wall-clock
approximation — `usage.output ÷ decode-window` measured from `message_update`/`message_end` — is the only
thing computable extension-side, and it isn't the provider's number.)

## Option 1 (recommended): surface response stats in Pi

A small, generally-useful change to `@earendil-works/pi-ai` would expose the data to every Pi client:

1. In the OpenAI-completions stream/response handling, capture the non-standard timing block when
   present — `stats` (LM Studio), `timings` (llama.cpp) — and Ollama's `eval_count`/`eval_duration` on
   the native path.
2. Attach it to the assistant message in a typed, optional field, e.g.
   `AssistantMessage.providerMetadata?: { tokensPerSecond?: number; timeToFirstTokenMs?: number; ... }`
   (or fold a normalized `tokensPerSecond` into `Usage`).
3. Make it available on the `message_end` / `turn_end` extension events.

This keeps Crossbar out of the inference path and benefits all providers, not just local ones.

### Crossbar follow-up once it lands

A few lines: register `message_end`, read `event.message.providerMetadata?.tokensPerSecond`, scope to
Crossbar providers (`registry.get(message.provider)`), and render it as a status item
(`ctx.ui.setStatus("crossbar-tps", "⚡ <n> tok/s")`) next to the loaded-model indicator. No new network
I/O, no proxy.

## Option 2 (heavy, not recommended): a Crossbar inference proxy

Crossbar could stand up a local reverse-proxy, register *that* as the backend URL, forward each request,
scrape `stats`/`timings` off the (streaming) response, and display the real figure. This is the only way
to get the provider's number **without** an upstream change — but it puts Crossbar in the critical
inference path (streaming SSE pass-through, auth, aborts, error mapping). A bug there breaks chat
entirely, which is a poor trade for a read-only stat. Documented for completeness; not planned.
