/**
 * OpenAI adapter conformance test. Runs the frozen conformance suite against the
 * OpenAI fixture. All assertions live in the harness; this file only wires them.
 */

import { runConformance } from "../conformance/run-conformance.ts";
import { openaiFixture } from "./openai.fixture.ts";

runConformance([openaiFixture]);
