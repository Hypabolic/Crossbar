/**
 * Conformance fixture for the generic OpenAI-compatible adapter.
 *
 * Covers: fingerprint positive/negative/auth-failure, listModels with ≥2 chat models
 * and 1 embeddings model (id containing "embed"), embed filtering, and inferenceBaseUrl.
 */

import type { ProbeResult } from "../../src/core/types.ts";
import type { AdapterFixture } from "../conformance/fixtures.ts";
import { UNAUTHORIZED } from "../conformance/fake-probe.ts";
import { genericAdapter } from "../../src/adapters/generic.ts";

// ---------------------------------------------------------------------------
// Canned responses
// ---------------------------------------------------------------------------

/** Normal /v1/models response: 2 chat models + 1 embeddings model. */
const MODELS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      { id: "generic-chat-alpha" },
      { id: "generic-chat-beta" },
      { id: "text-embed-small" }, // contains "embed" → must be excluded from chat list
    ],
  },
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export const genericFixture: AdapterFixture = {
  name: "OpenAI-compatible (generic)",
  adapter: genericAdapter,
  cred: { mode: "none" },

  // positive routes — all a generic server needs to respond to
  routes: {
    "/v1/models": MODELS_RESPONSE,
  },

  // negative: no /v1/models → fingerprint must return null
  negativeRoutes: {},

  // auth failure: 401 on /v1/models
  authFailureRoutes: {
    "/v1/models": UNAUTHORIZED,
  },

  expect: {
    fingerprint: {
      kind: "openai-generic",
      // LOW confidence so any specific adapter outranks at the same origin
      confidenceMin: 0.2,
      confidenceMax: 0.4,
    },
    models: {
      includedIds: ["generic-chat-alpha", "generic-chat-beta"],
      excludedIds: ["text-embed-small"],
      minCount: 2,
    },
    // IntrospectLoaded is NOT declared — no loadedState expected
    inferenceBaseUrlPrefix: "http://",
  },
};
