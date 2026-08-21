/**
 * Conformance fixture for the Unsloth Studio adapter.
 *
 * Routes below are captured verbatim from a live Unsloth Studio instance (2026-08-19, curl
 * against `/v1/models` with and without a valid `Authorization` header) — see unsloth.ts for
 * the full capture and rationale.
 *
 * Unsloth Studio characteristics exercised:
 *   - Fingerprint via the `Server: unsloth-studio` header, present on both the unauthenticated
 *     401 and the authenticated 200 — the only signal actually unique to this product (see
 *     unsloth.test.ts for the discrimination edge cases the shared harness doesn't reach).
 *   - listModels via the same endpoint, authenticated; `owned_by`, `context_length` /
 *     `max_context_length` / `native_context_length`, and `loaded` are real response fields.
 *   - IntrospectLoaded, sourced from the same `loaded: boolean` field per model — no separate
 *     endpoint.
 *   - `authRequired: true`.
 *   - No SwitchModel / LoadUnload / Health (capability honesty) — not exposed by this backend.
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeInit, ProbeResult } from "../../src/core/types.ts";
import { unslothAdapter } from "../../src/adapters/unsloth.ts";

const LOADED_MODEL_ID = "unsloth/Qwen3.8-27B-GGUF";
const UNLOADED_MODEL_ID = "Qwen3.6-35B-A3B-UD-Q4_K_XL";
const EMBED_ID = "nomic-embed-text-v1.5";

/** Captured verbatim: `GET /v1/models` with no (or an invalid) Authorization header. */
const UNAUTHENTICATED_RESPONSE: ProbeResult = {
  status: 401,
  ok: false,
  headers: {
    server: "unsloth-studio",
    "www-authenticate": "Bearer",
    "content-type": "application/json",
  },
  json: { error: { message: "Not authenticated", type: "authentication_error", param: null, code: null } },
};

/** Captured verbatim (trimmed to the fields this adapter reads) from the same live instance. */
const AUTHENTICATED_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: {
    server: "unsloth-studio",
    "content-type": "application/json",
  },
  json: {
    object: "list",
    data: [
      {
        id: LOADED_MODEL_ID,
        object: "model",
        owned_by: "unsloth-studio",
        quant: "UD-Q4_K_XL",
        context_length: 49152,
        max_context_length: 229888,
        native_context_length: 262144,
        loaded: true,
      },
      {
        id: UNLOADED_MODEL_ID,
        object: "model",
        owned_by: "unsloth-studio",
        loaded: false,
        display_name: UNLOADED_MODEL_ID,
      },
      {
        id: EMBED_ID,
        object: "model",
        owned_by: "unsloth-studio",
        loaded: false,
        display_name: EMBED_ID,
      },
    ],
  },
};

/**
 * Real Unsloth Studio behaviour: `GET /v1/models` 401s without a bearer token and 200s with
 * one, but sets the SAME `Server: unsloth-studio` header either way. `fingerprint()` calls the
 * bare probe with no headers of its own (in production it never sees the raw credential — the
 * orchestrator's bound `Probe` closure does that); `listModels()` attaches the `Authorization`
 * header itself from `cred`. This one factory route reproduces both paths so the harness's
 * fingerprint-positive test (no headers) and listModels happy-path test (cred's header
 * attached) — which share this same `routes` map — each see the real response shape.
 */
const MODELS_ROUTE = (init?: ProbeInit): ProbeResult =>
  init?.headers?.["Authorization"] ? AUTHENTICATED_RESPONSE : UNAUTHENTICATED_RESPONSE;

/**
 * Captured verbatim from the live instance (2026-08-19): `GET /api/settings/openai-auto-switch`
 * with a bearer token — the API surface of the "Switch model by request" toggle (Settings ▸ API).
 * `enabled: false` is the state that makes requests for unloaded models 404 with
 * `model_not_found`, which is exactly the case the adapter's `autoLoadsOnDemand` must surface.
 */
const AUTO_SWITCH_OFF_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: {
    server: "unsloth-studio",
    "content-type": "application/json",
  },
  json: {
    enabled: false,
    auto_unload_idle_seconds: 0,
    default_enabled: false,
    idle_unload_active: false,
    auto_unload_keep_kv: true,
    auto_download_model: false,
    auto_unload_api_only: false,
    media_auto_unload_idle_seconds: 0,
    media_idle_unload_active: false,
  },
};

/**
 * Another backend's response shape: no `Server: unsloth-studio` header at all. This is the
 * only signal this adapter's fingerprint claims a kind from, so anything lacking it — even a
 * plausible-looking 200 + `data[]` — must yield null.
 */
const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/v1/models": {
    status: 200,
    ok: true,
    headers: { server: "some-other-backend" },
    json: { object: "list", data: [{ id: "some-other-model", owned_by: "someone-else" }] },
  },
};

/** Auth failure for the shared harness's listModels 401 test — no header needed here. */
const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/v1/models": UNAUTHENTICATED_RESPONSE,
};

export const unslothFixture: AdapterFixture = {
  name: "Unsloth Studio",
  adapter: unslothAdapter,
  cred: { mode: "apiKey", apiKey: "sk-unsloth-test-key" },

  routes: {
    "/v1/models": MODELS_ROUTE,
    "/api/settings/openai-auto-switch": AUTO_SWITCH_OFF_RESPONSE,
  },

  negativeRoutes: NEGATIVE_ROUTES,
  authFailureRoutes: AUTH_FAILURE_ROUTES,

  expect: {
    fingerprint: {
      kind: "unsloth",
      confidenceMin: 0.9,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: [LOADED_MODEL_ID, UNLOADED_MODEL_ID],
      excludedIds: [EMBED_ID],
      minCount: 2,
    },
    loadedState: {
      anyOf: [LOADED_MODEL_ID],
      source: "introspection",
    },
    inferenceBaseUrlPrefix: "http://",
    // Unsloth Studio reports no context/token limits for unloaded models, so the adapter
    // deliberately emits maxTokens: 0 ("unbounded — let the server decide") rather than
    // inventing one. Same contract as llama.cpp and llama-swap.
    maxTokensMayBeUnbounded: true,
    // The fixture's settings endpoint reports the toggle OFF — the case that matters for
    // the picker warning (unloaded models 404 until loaded in the Studio UI).
    autoLoadStatus: { expected: false },
  },
};
