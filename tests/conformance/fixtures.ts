/**
 * Fixture types for the Crossbar conformance harness.
 *
 * `AdapterFixture` is the mini-contract Wave B adapters must satisfy: each
 * adapter ships one fixture object (or file) that the harness imports and
 * passes to `runConformance`.  The reference fixture in `reference-adapter.ts`
 * is the Wave A self-test.
 *
 * Design goals:
 *  - Fully data-driven: no adapter-specific logic lives in contract.test.ts.
 *  - The `routes` map is the recorded HTTP exchange (like VCR cassettes).
 *  - The `expect` block is the ground truth the harness asserts against.
 *  - `negativeRoutes` is another backend's response set; fingerprint MUST
 *    return null against it (validates discrimination).
 */

import type { BackendAdapter } from "../../src/core/backend-adapter.ts";
import type {
  DiscoveredServer,
  ProbeResult,
  ServerCredential,
} from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/**
 * Expected output from `listModels`, expressed as constraints the harness can
 * assert without knowing exact internal IDs.
 */
export interface ExpectedModels {
  /**
   * Model ids that MUST appear in the returned list.  The harness checks
   * inclusion, not exact equality, so fixture authors only need to list the
   * representative models they have fixtures for.
   */
  includedIds: string[];

  /**
   * Model ids that MUST NOT appear in the chat model list (embeddings that
   * the adapter must filter out).  Leave empty [] when the backend has none.
   */
  excludedIds: string[];

  /**
   * Minimum list length (≥1 after filtering).
   */
  minCount: number;
}

/**
 * Expected result from `fingerprint` (positive route set).
 */
export interface ExpectedFingerprint {
  /** The `DiscoveredServer.kind` value the adapter must return. */
  kind: DiscoveredServer["kind"];
  /** Inclusive lower bound on `DiscoveredServer.confidence`. */
  confidenceMin: number;
  /** Inclusive upper bound on `DiscoveredServer.confidence`. */
  confidenceMax: number;
}

/**
 * Expected result from `introspectLoaded` (happy-path fixture).
 * Only validated when the adapter declares `IntrospectLoaded`.
 */
export interface ExpectedLoadedState {
  /** At least one of these ids must appear in `loadedModelIds`. */
  anyOf: string[];
  /** Source must be "introspection" on the success path. */
  source: "introspection";
}

// ---------------------------------------------------------------------------
// AdapterFixture — the Wave B mini-contract
// ---------------------------------------------------------------------------

/**
 * Everything the conformance harness needs to exercise one adapter end-to-end.
 *
 * Wave B adapters add a fixture file that exports a value of this shape and
 * append it to the array passed to `runConformance()`.
 *
 * Required fields: name, adapter, cred, routes, expect.
 * Optional fields: server (override base URL), negativeRoutes, switchModelId,
 *   loadModelId, extraEdgeCases.
 */
export interface AdapterFixture {
  /**
   * Human-readable name shown in test output, e.g. "Ollama".
   */
  name: string;

  /**
   * The adapter instance under test.  Must implement `BackendAdapter`.
   */
  adapter: BackendAdapter;

  /**
   * Cloud adapters (OpenAI, Anthropic) are configured, never port-probed, so their `fingerprint`
   * returns null by contract.  Set `cloud: true` to skip the probe-only fingerprint assertions;
   * all other capability checks (listModels, toPiModel, inferenceBaseUrl, ...) still run.
   */
  cloud?: boolean;

  /**
   * The credential to pass for authenticated calls (listModels, switch, ...).
   * Use `{ mode: "none" }` for unauthenticated local backends.
   */
  cred: ServerCredential;

  /**
   * Optional: override the `DiscoveredServer` used in listModels / switch /
   * introspect calls.  When omitted, the harness uses the value returned by
   * `fingerprint` against `routes`.
   */
  server?: DiscoveredServer;

  /**
   * Positive fixture routes: responses that make the adapter return a
   * non-null DiscoveredServer from `fingerprint` AND let listModels, health,
   * introspectLoaded, switchModel, loadUnload succeed.
   *
   * Key: path (or "METHOD /path" for method-specific overrides).
   * Value: the canned ProbeResult.
   */
  routes: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)>;

  /**
   * Routes from a *different* backend that must cause `fingerprint` to return
   * null.  If omitted, only the presence of a null-path result (no fixtures)
   * is tested.
   */
  negativeRoutes?: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)>;

  /**
   * Routes to use for the auth-failure edge case in listModels / introspect.
   * When omitted, the harness uses a map that returns 401 for all paths.
   */
  authFailureRoutes?: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)>;

  /**
   * Routes that simulate server-down-mid-switch (status:0 on the confirmation
   * probe used inside switchModel).  Only used when `SwitchModel` is declared.
   */
  serverDownRoutes?: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)>;

  /**
   * Overlay merged onto `routes` for the switchModel SUCCESS path, so the post-switch confirmation
   * probe reflects the target as loaded (e.g. a sequenced introspect endpoint).  When omitted, the
   * success test uses `routes` as-is — make `routes` sufficient for a successful switch in that case.
   * Only used when `SwitchModel` is declared.
   */
  switchSuccessRoutes?: Record<string, ProbeResult | ((init?: import("../../src/core/types.ts").ProbeInit) => ProbeResult)>;

  /**
   * Model id to use when testing `switchModel`.  Defaults to
   * `expect.models.includedIds[0]`.
   */
  switchModelId?: string;

  /**
   * Model id to use when testing `loadUnload`.  Defaults to
   * `expect.models.includedIds[0]`.
   */
  loadModelId?: string;

  /**
   * Model id that is guaranteed NOT loaded / NOT available, used to exercise
   * model-not-loaded error paths.
   */
  missingModelId?: string;

  /** Ground-truth assertions the harness validates against. */
  expect: {
    /** What `fingerprint` must return for `routes`. */
    fingerprint: ExpectedFingerprint;

    /** What `listModels` must return. */
    models: ExpectedModels;

    /**
     * What `introspectLoaded` must return on the success path.
     * Required when `IntrospectLoaded` is in adapter.capabilities;
     * omit (or set undefined) when the capability is absent.
     */
    loadedState?: ExpectedLoadedState;

    /**
     * The base URL `inferenceBaseUrl` must return.
     * Expressed as a prefix so the test handles dynamic ports.
     * Must start with "http://" or "https://".
     */
    inferenceBaseUrlPrefix: string;
  };
}
