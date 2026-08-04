/**
 * Conformance fixture for the oMLX backend adapter.
 *
 * Provides the route map (positive, negative, auth-failure) and ground-truth
 * assertions that the conformance harness validates against.
 *
 * oMLX characteristics exercised:
 *   - Fingerprint via GET /v1/models with owned_by:"omlx" and max_model_len
 *   - Model with max_model_len → contextWindow (the key bug fix)
 *   - GET /health returns empty 200 ⇒ healthy (no auth required)
 *   - GET /v1/models/status → loaded model residency (rich response)
 *   - SwitchModel: POST /v1/models/{id}/load → confirm via GET /v1/models/status
 *   - LoadUnload: POST /v1/models/{id}/load or /{id}/unload
 *   - PerModelCaps via max_model_len and status endpoint
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import { REFUSED, UNAUTHORIZED } from "../conformance/fake-probe.ts";

// ---------------------------------------------------------------------------
// Import adapter and types under test
// ---------------------------------------------------------------------------

// We import the adapter that will be created alongside this fixture.
// During development this will reference a non-existent file, but the test
// framework handles that gracefully when we run the adapter test directly.
import { omlxAdapter } from "../../src/adapters/omlx.ts";

// ---------------------------------------------------------------------------
// Model fixture data
// ---------------------------------------------------------------------------

const MODEL_ID = "Qwen3.6-35B-A3B-4bit";
const CONTEXT_WINDOW = 65536; // The value from the bug report
const MODEL_PATH = "/Users/hauke/models/mlx-community/Qwen3.6-35B-A3B-4bit";
const ESTIMATED_SIZE = 21422314484;
const ACTUAL_SIZE = 20688526176;

// ---------------------------------------------------------------------------
// Canned responses
// ---------------------------------------------------------------------------

const MODELS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    object: "list",
    data: [
      {
        id: MODEL_ID,
        object: "model",
        created: 1784327392,
        owned_by: "omlx",
        max_model_len: CONTEXT_WINDOW,
      },
    ],
  },
};

const MODELS_STATUS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    object: "list",
    // Prefer oMLX's `models` shape (also accepts OpenAI-style `data`).
    models: [
      {
        id: MODEL_ID,
        model_alias: MODEL_ID,
        model_path: MODEL_PATH,
        loaded: true,
        is_loading: false,
        estimated_size: ESTIMATED_SIZE,
        actual_size: ACTUAL_SIZE,
        max_context_window: CONTEXT_WINDOW,
        max_tokens: 32768,
        model_type: "llm",
        thinking_default: true,
      },
    ],
  },
};

const LOAD_SUCCESS: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    status: "ok",
    model_id: MODEL_ID,
  },
};

const UNLOAD_SUCCESS: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    status: "ok",
    model_id: MODEL_ID,
  },
};

// Status response showing the target model is loaded (for switchModel confirmation).
const SWITCHED_STATUS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    object: "list",
    data: [
      {
        id: MODEL_ID,
        model_path: MODEL_PATH,
        loaded: true,
        is_loading: false,
        estimated_size: ESTIMATED_SIZE,
        actual_size: ACTUAL_SIZE,
        max_context_window: CONTEXT_WINDOW,
        max_tokens: 32768,
      },
    ],
  },
};

const HEALTH_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: {},
  text: "",
  latencyMs: 2,
};

// ---------------------------------------------------------------------------
// Negative routes — responses from a different backend must NOT match oMLX
// ---------------------------------------------------------------------------

const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/v1/models": {
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json: {
      object: "list",
      data: [
        {
          id: "some-other-model",
          object: "model",
          created: 1700000000,
          owned_by: "other",
          max_model_len: 32768,
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Auth failure routes — /v1/models returns 401
// ---------------------------------------------------------------------------

const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/v1/models": UNAUTHORIZED,
  "/v1/models/status": UNAUTHORIZED,
  "/health": REFUSED,
};

// ---------------------------------------------------------------------------
// omlxFixture
// ---------------------------------------------------------------------------

export const omlxFixture: AdapterFixture = {
  name: "oMLX",
  adapter: omlxAdapter,
  cred: { mode: "none" },

  // Positive route set — covers fingerprint, listModels, health, introspect
  routes: {
    "/v1/models": MODELS_RESPONSE,
    "/v1/models/status": MODELS_STATUS_RESPONSE, // enriched with thinking_default → reasoning
    "/health": HEALTH_OK,
    [`/v1/models/${MODEL_ID}/load`]: LOAD_SUCCESS,
    [`/v1/models/${MODEL_ID}/unload`]: UNLOAD_SUCCESS,
  },

  // Routes for switchModel and loadUnload — the conformance harness calls
  // `/v1/models/${modelId}/load` and `/v1/models/${modelId}/unload`.
  switchSuccessRoutes: {
    [`/v1/models/${MODEL_ID}/load`]: LOAD_SUCCESS,
    [`/v1/models/${MODEL_ID}/unload`]: UNLOAD_SUCCESS,
    "/v1/models/status": SWITCHED_STATUS_RESPONSE,
  },

  // Another backend's responses — must yield fingerprint null
  negativeRoutes: NEGATIVE_ROUTES,

  // Auth-failure routes — listModels must throw on 401
  authFailureRoutes: AUTH_FAILURE_ROUTES,

  expect: {
    fingerprint: {
      kind: "omlx",
      confidenceMin: 0.8,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: [MODEL_ID],
      excludedIds: [],
      minCount: 1,
    },
    loadedState: {
      anyOf: [MODEL_ID],
      source: "introspection",
    },
    inferenceBaseUrlPrefix: "http://",
  },

  // Conformance harness fields for switchModel / loadUnload tests.
  switchModelId: MODEL_ID,
  loadModelId: MODEL_ID,
  missingModelId: "no-such-model",
};
