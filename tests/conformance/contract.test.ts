/**
 * Crossbar conformance self-test (Wave A): runs the contract suite against the reference adapter.
 *
 * The runnable suite lives in ./run-conformance.ts so adapter test files can reuse it without
 * importing this test file. Wave B adapters add their own `tests/adapters/<kind>.test.ts` that calls
 * `runConformance([<kind>Fixture])`.
 */

import { runConformance } from "./run-conformance.ts";
import { referenceFixture } from "./reference-adapter.ts";

runConformance([referenceFixture]);
