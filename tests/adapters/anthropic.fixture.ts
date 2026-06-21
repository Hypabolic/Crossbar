/**
 * Conformance fixture for the Anthropic cloud adapter.
 *
 * Anthropic is a cloud backend (`cloud: true`) — fingerprint/probe assertions
 * are skipped. The fake Probe ignores headers, so the auth headers the adapter
 * sets (x-api-key + anthropic-version) are exercised for shape only; route
 * matching is by path.
 */

import type { ProbeResult } from "../../src/core/types.ts";
import { anthropicAdapter } from "../../src/adapters/anthropic.ts";
import type { AdapterFixture } from "../conformance/fixtures.ts";
import { UNAUTHORIZED } from "../conformance/fake-probe.ts";

const BASE_URL = "https://api.anthropic.com";

/** GET /v1/models — Anthropic carries per-model caps inline. */
const MODELS_RESPONSE: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    data: [
      {
        id: "claude-sonnet-4-20250514",
        display_name: "Claude Sonnet 4",
        max_input_tokens: 200000,
        max_tokens: 64000,
        capabilities: { image_input: true, thinking: true },
      },
      {
        id: "claude-3-5-haiku-20241022",
        display_name: "Claude Haiku 3.5",
        max_input_tokens: 200000,
        max_tokens: 8192,
        capabilities: { image_input: false, thinking: false },
      },
    ],
  },
};

export const anthropicFixture: AdapterFixture = {
  name: "Anthropic",
  adapter: anthropicAdapter,
  cloud: true,
  cred: { mode: "apiKey", apiKey: "test-key" },

  server: {
    kind: "anthropic",
    baseUrl: BASE_URL,
    auth: "apiKey",
    label: "Anthropic",
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
      kind: "anthropic",
      confidenceMin: 0,
      confidenceMax: 1,
    },
    models: {
      includedIds: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
      excludedIds: [],
      minCount: 2,
    },
    inferenceBaseUrlPrefix: "https://",
  },
};
