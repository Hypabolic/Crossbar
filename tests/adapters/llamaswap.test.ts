/**
 * Conformance test for the llama-swap adapter.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { llamaswapFixture } from "./llamaswap.fixture.ts";

runConformance([llamaswapFixture]);
