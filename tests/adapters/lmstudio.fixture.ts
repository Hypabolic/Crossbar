/**
 * Conformance fixture for the LM Studio adapter.
 *
 * Provides canned HTTP responses covering:
 *   - positive fingerprint (LM Studio /api/v0/models with state + compatibility_type)
 *   - negative fingerprint (Ollama "/" response)
 *   - auth failure (401)
 *   - server-down-mid-switch (load ok then models list REFUSED)
 *   - switchSuccessRoutes (model shows state "loaded" after load POST)
 *
 * Model set:
 *   lms-chat-a   — llm, not-loaded
 *   lms-vlm-b    — vlm (vision), loaded
 *   lms-embed-c  — embeddings (must be excluded from chat registration)
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import { REFUSED, UNAUTHORIZED, sequence } from "../conformance/fake-probe.ts";
import { lmstudioAdapter } from "../../src/adapters/lmstudio.ts";

// ---------------------------------------------------------------------------
// Canned model payloads
// ---------------------------------------------------------------------------

/** LM Studio /api/v0/models response — lms-vlm-b is loaded; lms-chat-a is not. */
const MODELS_ALL: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      {
        id: "lms-chat-a",
        type: "llm",
        state: "not-loaded",
        compatibility_type: "gguf",
        max_context_length: 32768,
        loaded_context_length: 0,
        quantization: "Q4_K_M",
        arch: "llama",
      },
      {
        id: "lms-vlm-b",
        type: "vlm",
        state: "loaded",
        compatibility_type: "gguf",
        max_context_length: 8192,
        loaded_context_length: 8192,
        quantization: "Q4_K_M",
        arch: "llava",
      },
      {
        id: "lms-embed-c",
        type: "embeddings",
        state: "not-loaded",
        compatibility_type: "gguf",
        max_context_length: 512,
        loaded_context_length: 0,
        quantization: "F32",
        arch: "bert",
      },
    ],
  },
};

/**
 * After switching to lms-chat-a: that model is now loaded.
 * lms-vlm-b reverts to not-loaded for simplicity.
 */
const MODELS_AFTER_SWITCH: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      {
        id: "lms-chat-a",
        type: "llm",
        state: "loaded",
        compatibility_type: "gguf",
        max_context_length: 32768,
        loaded_context_length: 32768,
        quantization: "Q4_K_M",
        arch: "llama",
      },
      {
        id: "lms-vlm-b",
        type: "vlm",
        state: "not-loaded",
        compatibility_type: "gguf",
        max_context_length: 8192,
        loaded_context_length: 0,
        quantization: "Q4_K_M",
        arch: "llava",
      },
      {
        id: "lms-embed-c",
        type: "embeddings",
        state: "not-loaded",
        compatibility_type: "gguf",
        max_context_length: 512,
        loaded_context_length: 0,
        quantization: "F32",
        arch: "bert",
      },
    ],
  },
};

/** Generic 200 OK for load/unload POSTs. */
const LOAD_UNLOAD_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { success: true },
};

// ---------------------------------------------------------------------------
// Route sets
// ---------------------------------------------------------------------------

/** Positive happy-path routes (vlm-b is loaded). */
const POSITIVE_ROUTES: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)> = {
  "/api/v0/models": MODELS_ALL,
  "POST /api/v1/models/load": LOAD_UNLOAD_OK,
  "POST /api/v1/models/unload": LOAD_UNLOAD_OK,
};

/**
 * switchSuccessRoutes: load POST succeeds, then the confirmation GET
 * /api/v0/models returns lms-chat-a as loaded.
 */
const SWITCH_SUCCESS_ROUTES: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)> = {
  "POST /api/v1/models/load": LOAD_UNLOAD_OK,
  "/api/v0/models": MODELS_AFTER_SWITCH,
};

/**
 * serverDownRoutes: load POST succeeds but the confirmation GET /api/v0/models
 * returns REFUSED (connection dropped mid-switch).
 */
const SERVER_DOWN_ROUTES: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)> = {
  "POST /api/v1/models/load": LOAD_UNLOAD_OK,
  "/api/v0/models": sequence(REFUSED),
};

/** negativeRoutes: Ollama root response — must yield null from fingerprint. */
const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/": {
    status: 200,
    ok: true,
    headers: { "content-type": "text/plain" },
    text: "Ollama is running",
  },
};

/** authFailureRoutes: every path returns 401. */
const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "/api/v0/models": UNAUTHORIZED,
  "POST /api/v1/models/load": UNAUTHORIZED,
  "POST /api/v1/models/unload": UNAUTHORIZED,
};

// ---------------------------------------------------------------------------
// Fixture export
// ---------------------------------------------------------------------------

export const lmstudioFixture: AdapterFixture = {
  name: "LM Studio",
  adapter: lmstudioAdapter,
  cred: { mode: "none" },

  routes: POSITIVE_ROUTES,
  negativeRoutes: NEGATIVE_ROUTES,
  authFailureRoutes: AUTH_FAILURE_ROUTES,
  serverDownRoutes: SERVER_DOWN_ROUTES,
  switchSuccessRoutes: SWITCH_SUCCESS_ROUTES,

  switchModelId: "lms-chat-a",
  loadModelId: "lms-chat-a",
  missingModelId: "no-such-model",

  expect: {
    fingerprint: {
      kind: "lmstudio",
      confidenceMin: 0.9,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: ["lms-chat-a", "lms-vlm-b"],
      excludedIds: ["lms-embed-c"],
      minCount: 2,
    },
    loadedState: {
      anyOf: ["lms-vlm-b"],
      source: "introspection",
    },
    inferenceBaseUrlPrefix: "http://",
  },
};
