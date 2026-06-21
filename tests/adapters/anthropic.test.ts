/**
 * Anthropic adapter conformance test. Runs the frozen conformance suite against
 * the Anthropic fixture. All assertions live in the harness; this file only wires
 * them.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { anthropicFixture } from "./anthropic.fixture.ts";

runConformance([anthropicFixture]);
