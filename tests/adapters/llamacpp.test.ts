/**
 * Conformance test for the llama.cpp (llama-server) adapter.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { llamacppFixture } from "./llamacpp.fixture.ts";

runConformance([llamacppFixture]);
