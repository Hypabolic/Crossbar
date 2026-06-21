/**
 * Conformance test for the generic OpenAI-compatible adapter.
 *
 * Runs the full parameterised harness against genericFixture.
 * No adapter-specific logic here — all assertions live in run-conformance.ts.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { genericFixture } from "./generic.fixture.ts";

runConformance([genericFixture]);
