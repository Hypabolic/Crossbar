/**
 * Conformance fixture for the Ollama backend adapter.
 *
 * Provides routes that simulate a real Ollama instance:
 *   - Two chat models (llama3.2:3b, mistral:7b)
 *   - One embeddings model (nomic-embed-text:latest)
 *   - /api/ps shows llama3.2:3b as loaded
 *   - switchSuccessRoutes: /api/ps shows mistral:7b after switch
 *   - serverDownRoutes: generate ok, /api/ps REFUSED
 *   - negativeRoutes: LM Studio-style /api/v0/models response
 *   - authFailureRoutes: 401 on key paths
 */

import type { AdapterFixture } from "../conformance/fixtures.ts";
import type { ProbeResult } from "../../src/core/types.ts";
import { REFUSED, UNAUTHORIZED, sequence } from "../conformance/fake-probe.ts";
import { ollamaAdapter } from "../../src/adapters/ollama.ts";

// ---------------------------------------------------------------------------
// Model IDs
// ---------------------------------------------------------------------------

const CHAT_MODEL_A = "llama3.2:3b";
const CHAT_MODEL_B = "mistral:7b";
const EMBED_MODEL = "nomic-embed-text:latest";

// ---------------------------------------------------------------------------
// Route fixtures
// ---------------------------------------------------------------------------

/** GET / → Ollama sentinel text */
const ROOT_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "text/plain" },
  text: "Ollama is running",
};

/** GET /api/version → version info */
const VERSION_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { version: "0.5.0" },
};

/** GET /api/tags → all models */
const TAGS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    models: [
      {
        name: CHAT_MODEL_A,
        model: CHAT_MODEL_A,
        details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" },
      },
      {
        name: CHAT_MODEL_B,
        model: CHAT_MODEL_B,
        details: { family: "mistral", parameter_size: "7B", quantization_level: "Q4_K_M" },
      },
      {
        name: EMBED_MODEL,
        model: EMBED_MODEL,
        details: { family: "bert", parameter_size: "137M", quantization_level: "F32" },
      },
    ],
  },
};

/**
 * POST /api/show → per-model capabilities.
 * Returns different shapes depending on which model is requested.
 */
function showResponse(init?: import("../../src/core/types.ts").ProbeInit): ProbeResult {
  let model = "";
  try {
    const body = JSON.parse(init?.body ?? "{}") as { name?: string };
    model = body.name ?? "";
  } catch {
    // ignore parse errors
  }

  if (model === EMBED_MODEL) {
    return {
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      json: {
        capabilities: ["embedding"],
        model_info: { "bert.context_length": 512 },
      },
    };
  }

  if (model === CHAT_MODEL_B) {
    return {
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      json: {
        capabilities: ["completion", "tools"],
        model_info: { "llm.context_length": 32768 },
      },
    };
  }

  // Default: CHAT_MODEL_A and anything else
  return {
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json: {
      capabilities: ["completion"],
      model_info: { "llm.context_length": 131072 },
    },
  };
}

/** GET /api/ps → llama3.2:3b is loaded */
const PS_WITH_MODEL_A: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    models: [
      {
        name: CHAT_MODEL_A,
        model: CHAT_MODEL_A,
        expires_at: "2026-06-21T20:00:00Z",
        size_vram: 2_000_000_000,
      },
    ],
  },
};

/** GET /api/ps → mistral:7b is loaded (after switch) */
const PS_WITH_MODEL_B: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    models: [
      {
        name: CHAT_MODEL_B,
        model: CHAT_MODEL_B,
        expires_at: "2026-06-21T20:00:00Z",
        size_vram: 4_500_000_000,
      },
    ],
  },
};

/** POST /api/generate → generic 200 OK (load/switch trigger) */
const GENERATE_OK: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: { model: CHAT_MODEL_A, response: "", done: true },
};

// ---------------------------------------------------------------------------
// Negative routes: LM Studio-style response that must yield null
// ---------------------------------------------------------------------------

const NEGATIVE_ROUTES: Record<string, ProbeResult> = {
  "/api/v0/models": {
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json: {
      data: [
        {
          id: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
          object: "model",
          type: "llm",
          state: "not-loaded",
          compatibility_type: "gguf",
          max_context_length: 8192,
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Auth-failure routes: 401 on the key paths
// ---------------------------------------------------------------------------

const AUTH_FAILURE_ROUTES: Record<string, ProbeResult> = {
  "GET /api/tags": UNAUTHORIZED,
  "GET /api/ps": UNAUTHORIZED,
  "POST /api/generate": UNAUTHORIZED,
};

// ---------------------------------------------------------------------------
// Server-down-mid-switch: generate succeeds, then /api/ps is REFUSED
// ---------------------------------------------------------------------------

const SERVER_DOWN_ROUTES: Record<
  string,
  ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)
> = {
  "/": ROOT_RESPONSE,
  "POST /api/generate": GENERATE_OK,
  "GET /api/ps": REFUSED,
};

// ---------------------------------------------------------------------------
// Switch-success overlay: /api/ps shows mistral:7b after switch to it
// ---------------------------------------------------------------------------

const SWITCH_SUCCESS_ROUTES: Record<
  string,
  ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)
> = {
  "POST /api/generate": GENERATE_OK,
  "GET /api/ps": PS_WITH_MODEL_B,
};

// ---------------------------------------------------------------------------
// Primary route map
// ---------------------------------------------------------------------------

const PRIMARY_ROUTES: Record<
  string,
  ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)
> = {
  "/": ROOT_RESPONSE,
  "/api/version": VERSION_RESPONSE,
  "GET /api/tags": TAGS_RESPONSE,
  "POST /api/show": showResponse,
  "GET /api/ps": PS_WITH_MODEL_A,
  "POST /api/generate": GENERATE_OK,
};

// ---------------------------------------------------------------------------
// Fixture export
// ---------------------------------------------------------------------------

export const ollamaFixture: AdapterFixture = {
  name: "Ollama",
  adapter: ollamaAdapter,
  cred: { mode: "none" },

  routes: PRIMARY_ROUTES,
  negativeRoutes: NEGATIVE_ROUTES,
  authFailureRoutes: AUTH_FAILURE_ROUTES,
  serverDownRoutes: SERVER_DOWN_ROUTES,
  switchSuccessRoutes: SWITCH_SUCCESS_ROUTES,

  switchModelId: CHAT_MODEL_B,
  loadModelId: CHAT_MODEL_A,
  missingModelId: "no-such-model:latest",

  expect: {
    fingerprint: {
      kind: "ollama",
      confidenceMin: 0.9,
      confidenceMax: 1.0,
    },
    models: {
      includedIds: [CHAT_MODEL_A, CHAT_MODEL_B],
      excludedIds: [EMBED_MODEL],
      minCount: 2,
    },
    loadedState: {
      anyOf: [CHAT_MODEL_A],
      source: "introspection",
    },
    inferenceBaseUrlPrefix: "http://",
  },
};
