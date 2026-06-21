/**
 * Conformance tests for the vLLM backend adapter.
 *
 * Delegates entirely to the shared conformance harness — no adapter-specific
 * logic here. Add per-adapter edge cases below if needed.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { vllmFixture } from "./vllm.fixture.ts";

runConformance([vllmFixture]);
