/**
 * Conformance fixture for the OpenAI cloud adapter.
 *
 * OpenAI is a cloud backend (`cloud: true`) — the harness skips all
 * fingerprint/probe assertions and relies on the explicit `server` below for
 * the listModels / toPiModel / inferenceBaseUrl checks.
 */

import type { ProbeResult } from "../../src/core/types.ts";
import { openaiAdapter } from "../../src/adapters/openai.ts";
import type { AdapterFixture } from "../conformance/fixtures.ts";
import { UNAUTHORIZED } from "../conformance/fake-probe.ts";

const BASE_URL = "https://api.openai.com/v1";

/** GET /v1/models — chat ids plus one embeddings id that must be filtered out. */
const MODELS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    object: "list",
    data: [
      { id: "gpt-4o", object: "model", owned_by: "openai" },
      { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
      { id: "o3", object: "model", owned_by: "openai" },
      { id: "text-embedding-3-small", object: "model", owned_by: "openai" },
    ],
  },
};

export const openaiFixture: AdapterFixture = {
  name: "OpenAI",
  adapter: openaiAdapter,
  cloud: true,
  cred: { mode: "apiKey", apiKey: "test-key" },

  server: {
    kind: "openai",
    baseUrl: BASE_URL,
    auth: "apiKey",
    label: "OpenAI",
    confidence: 1,
  },

  routes: {
    "GET /v1/models": MODELS_RESPONSE,
  },

  authFailureRoutes: {
    "/v1/models": UNAUTHORIZED,
  },

  expect: {
    // Unused for cloud adapters (fingerprint tests are skipped) but required by the type.
    fingerprint: {
      kind: "openai",
      confidenceMin: 0,
      confidenceMax: 1,
    },
    models: {
      includedIds: ["gpt-4o", "gpt-4o-mini", "o3"],
      excludedIds: ["text-embedding-3-small"],
      minCount: 3,
    },
    inferenceBaseUrlPrefix: "https://",
  },
};
