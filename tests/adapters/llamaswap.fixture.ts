/**
 * Conformance fixture for the llama-swap adapter.
 *
 * Two configured models: model-a (currently running), model-b (switch target).
 * Exercises: fingerprint, listModels, introspectLoaded, switchModel, loadUnload, health.
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import { REFUSED, UNAUTHORIZED } from "../conformance/fake-probe.ts";
import { llamaswapAdapter } from "../../src/adapters/llamaswap.ts";

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

const MODEL_A = "llama3.1-8b-q4";
const MODEL_B = "mistral-7b-q4";

// ---------------------------------------------------------------------------
// Route responses
// ---------------------------------------------------------------------------

/** GET /running — model-a is currently active */
const RUNNING_RESPONSE_A: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { id: MODEL_A, status: "running" },
};

/** GET /running — model-b is active (after switch) */
const RUNNING_RESPONSE_B: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { id: MODEL_B, status: "running" },
};

/** GET /v1/models — two configured models */
const MODELS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    object: "list",
    data: [
      { id: MODEL_A, object: "model", created: 1719000000, owned_by: "llamaswap" },
      { id: MODEL_B, object: "model", created: 1719000001, owned_by: "llamaswap" },
    ],
  },
};

/** GET /upstream/{MODEL_A} — start/confirm upstream model-a */
const UPSTREAM_A_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { ok: true, model: MODEL_A },
};

/** GET /upstream/{MODEL_B} — start/confirm upstream model-b */
const UPSTREAM_B_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { ok: true, model: MODEL_B },
};

/** POST /api/models/unload — acknowledged */
const UNLOAD_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { ok: true },
};

/** GET /health — plain "OK" text response from llama-swap */
const HEALTH_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "text/plain" },
  text: "OK",
  latencyMs: 2,
};

// ---------------------------------------------------------------------------
// Negative routes — bare llama-server /props (no /running) ⇒ fingerprint null
// ---------------------------------------------------------------------------

const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/props": {
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json: {
      default_generation_settings: { n_ctx: 4096 },
      build_info: { build_number: 3518 },
      model_path: "/home/user/models/some-model.gguf",
    },
  },
  "/v1/models": MODELS_RESPONSE,
};

// ---------------------------------------------------------------------------
// Auth-failure routes
// ---------------------------------------------------------------------------

const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/running": UNAUTHORIZED,
  "/v1/models": UNAUTHORIZED,
};

// ---------------------------------------------------------------------------
// Server-down-mid-switch routes
// /upstream/{MODEL_B} succeeds, but /running returns REFUSED on confirmation
// ---------------------------------------------------------------------------

const SERVER_DOWN_ROUTES: Record<string, ProbeResult> = {
  [`/upstream/${MODEL_B}`]: UPSTREAM_B_OK,
  "/running": REFUSED,
};

// ---------------------------------------------------------------------------
// Switch-success overlay
// After switching to model-b, /running reports model-b
// ---------------------------------------------------------------------------

const SWITCH_SUCCESS_ROUTES: Record<string, ProbeResult> = {
  [`/upstream/${MODEL_B}`]: UPSTREAM_B_OK,
  "/running": RUNNING_RESPONSE_B,
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export const llamaswapFixture: AdapterFixture = {
  name: "llama-swap",
  adapter: llamaswapAdapter,
  cred: { mode: "none" },

  routes: {
    "/running": RUNNING_RESPONSE_A,
    "/v1/models": MODELS_RESPONSE,
    [`/upstream/${MODEL_A}`]: UPSTREAM_A_OK,
    [`/upstream/${MODEL_B}`]: UPSTREAM_B_OK,
    "POST /api/models/unload": UNLOAD_OK,
    "/health": HEALTH_OK,
  },

  negativeRoutes: NEGATIVE_ROUTES,
  authFailureRoutes: AUTH_FAILURE_ROUTES,
  serverDownRoutes: SERVER_DOWN_ROUTES,
  switchSuccessRoutes: SWITCH_SUCCESS_ROUTES,

  switchModelId: MODEL_B,
  loadModelId: MODEL_A,

  expect: {
    fingerprint: {
      kind: "llamaswap",
      confidenceMin: 0.8,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: [MODEL_A, MODEL_B],
      excludedIds: [],
      minCount: 2,
    },
    loadedState: {
      anyOf: [MODEL_A],
      source: "introspection",
    },
    inferenceBaseUrlPrefix: "http://",
  },
};
