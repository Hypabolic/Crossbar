/**
 * Conformance fixture for the llama.cpp (llama-server) adapter.
 *
 * Single-model instance: model id "Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf"
 * loaded from /home/user/models/Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf
 * No SwitchModel / LoadUnload (single model per instance).
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import { UNAUTHORIZED } from "../conformance/fake-probe.ts";
import { llamacppAdapter } from "../../src/adapters/llamacpp.ts";

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

const MODEL_ID = "Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf";
const MODEL_PATH = `/home/user/models/${MODEL_ID}`;
const N_CTX = 4096;

// ---------------------------------------------------------------------------
// Route responses
// ---------------------------------------------------------------------------

/** GET /props — the fingerprint + introspect endpoint */
const PROPS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    default_generation_settings: {
      n_ctx: N_CTX,
      temperature: 0.8,
      top_p: 0.95,
    },
    build_info: {
      build_number: 3518,
      commit: "abc1234",
      compiler: "gcc-13",
    },
    model_path: MODEL_PATH,
    modalities: ["text"],
  },
};

/** GET /v1/models — single model */
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
        created: 1719000000,
        owned_by: "llamacpp",
        meta: {
          vocab_type: 2,
          n_vocab: 128256,
          n_ctx_train: 131072,
          n_embd: 4096,
          n_params: 8030000000,
          size: 4661000000,
        },
      },
    ],
  },
};

/** GET /health — server healthy */
const HEALTH_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { status: "ok" },
  latencyMs: 3,
};

// ---------------------------------------------------------------------------
// Negative routes — llama-swap /running present, no llama-server /props
// This causes llamacpp fingerprint to return null (no build_info / DGS on /props).
// ---------------------------------------------------------------------------

const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/running": {
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json: { id: "some-model", status: "running" },
  },
  "/v1/models": MODELS_RESPONSE,
};

// ---------------------------------------------------------------------------
// Auth-failure routes — 401 on every call
// ---------------------------------------------------------------------------

const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/props": UNAUTHORIZED,
  "/v1/models": UNAUTHORIZED,
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export const llamacppFixture: AdapterFixture = {
  name: "llama.cpp (llama-server)",
  adapter: llamacppAdapter,
  cred: { mode: "none" },

  routes: {
    "/props": PROPS_RESPONSE,
    "/v1/models": MODELS_RESPONSE,
    "/health": HEALTH_OK,
  },

  negativeRoutes: NEGATIVE_ROUTES,
  authFailureRoutes: AUTH_FAILURE_ROUTES,

  expect: {
    fingerprint: {
      kind: "llamacpp",
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
};
