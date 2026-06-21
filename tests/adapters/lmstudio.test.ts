/**
 * LM Studio adapter conformance tests.
 *
 * Delegates entirely to the shared conformance harness — all assertions live
 * in run-conformance.ts; this file wires in the lmstudio fixture.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { lmstudioFixture } from "./lmstudio.fixture.ts";

runConformance([lmstudioFixture]);
