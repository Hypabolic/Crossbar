/**
 * Conformance fixture for the vLLM adapter.
 *
 * Provides the route map (positive, negative, auth-failure) and ground-truth
 * assertions that the conformance harness validates against.
 *
 * vLLM characteristics exercised:
 *   - Fingerprint via GET /version ({"version":...}) and GET /v1/models (owned_by:"vllm")
 *   - Single served model with max_model_len → contextWindow
 *   - GET /health returns empty 200 ⇒ healthy
 *   - No IntrospectLoaded / SwitchModel / LoadUnload (capability honesty)
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import { REFUSED, UNAUTHORIZED } from "../conformance/fake-probe.ts";
import { vllmAdapter } from "../../src/adapters/vllm.ts";

// ---------------------------------------------------------------------------
// Model fixture data
// ---------------------------------------------------------------------------

const MODEL_ID = "meta-llama/Llama-3.1-8B-Instruct";

// ---------------------------------------------------------------------------
// Canned responses
// ---------------------------------------------------------------------------

const VERSION_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { version: "0.6.3" },
};

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
        created: 1716000000,
        owned_by: "vllm",
        max_model_len: 32768,
        root: MODEL_ID,
        parent: null,
      },
    ],
  },
};

const HEALTH_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: {},
  // vLLM /health returns an empty 200 body
  text: "",
  latencyMs: 3,
};

// ---------------------------------------------------------------------------
// Negative routes — Ollama-style root text, no /version JSON
// ---------------------------------------------------------------------------

const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/": {
    status: 200,
    ok: true,
    headers: { "content-type": "text/plain" },
    text: "Ollama is running",
  },
};

// ---------------------------------------------------------------------------
// Auth failure routes — /v1/models returns 401
// ---------------------------------------------------------------------------

const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/v1/models": UNAUTHORIZED,
  "/version": REFUSED,
};

// ---------------------------------------------------------------------------
// vllmFixture
// ---------------------------------------------------------------------------

export const vllmFixture: AdapterFixture = {
  name: "vLLM",
  adapter: vllmAdapter,
  cred: { mode: "none" },

  // Positive route set — covers fingerprint, listModels, health
  routes: {
    "/version": VERSION_RESPONSE,
    "/v1/models": MODELS_RESPONSE,
    "/health": HEALTH_OK,
  },

  // Another backend's responses — must yield fingerprint null
  negativeRoutes: NEGATIVE_ROUTES,

  // Auth-failure routes — listModels must throw on 401
  authFailureRoutes: AUTH_FAILURE_ROUTES,

  expect: {
    fingerprint: {
      kind: "vllm",
      confidenceMin: 0.8,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: [MODEL_ID],
      excludedIds: [],
      minCount: 1,
    },
    // loadedState intentionally absent — IntrospectLoaded not declared
    inferenceBaseUrlPrefix: "http://",
  },
};
