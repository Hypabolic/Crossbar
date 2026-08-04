/** Live test: verify oMLX thinking capability is parsed from /v1/models/status */
import { describe, it, expect } from "vitest";
import { omlxAdapter } from "../../src/adapters/omlx.ts";
import type { Probe, ProbeResult } from "../../src/core/types.ts";

/**
 * Live test: verify oMLX thinking capability is parsed from /v1/models/status.
 *
 * Run with: LIVE_TEST=1 npx vitest run tests/adapters/omlx-thinking-live.test.ts
 * Skipped by default (no network).
 */
describe.skipIf(!process.env.LIVE_TEST)("oMLX thinking capability (live)", () => {
  const baseUrl = "http://127.0.0.1:8000";

  const probe: Probe = async (path, init) => {
    // exactOptionalPropertyTypes: only set method/headers when defined (match src/discovery/probe.ts).
    const fetchInit: RequestInit = {};
    if (init?.method !== undefined) fetchInit.method = init.method;
    if (init?.headers !== undefined) fetchInit.headers = init.headers;
    if (init?.body !== undefined) fetchInit.body = init.body;

    const r = await fetch(
      baseUrl + path,
      Object.keys(fetchInit).length > 0 ? fetchInit : undefined,
    );
    const text = await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const result: ProbeResult = {
      status: r.status,
      ok: r.ok,
      headers: Object.fromEntries(r.headers.entries()),
    };
    if (text !== undefined) result.text = text;
    if (json !== undefined) result.json = json;
    return result;
  };

  it("parses thinking_default as reasoning from status endpoint", async () => {
    const server = await omlxAdapter.fingerprint(baseUrl, probe);
    expect(server).not.toBeNull();
    if (!server) return;

    const models = await omlxAdapter.listModels(server, { mode: "none" }, probe);

    // Models with thinking_default:true should have reasoning=true
    const thinkingModels = models.filter((m) => m.reasoning);
    const nonThinkingModels = models.filter((m) => !m.reasoning);

    console.log(
      `Total: ${models.length}, Thinking: ${thinkingModels.length}, Non-thinking: ${nonThinkingModels.length}`,
    );
    thinkingModels.forEach((m) => console.log(`  ✓ ${m.id}`));
    nonThinkingModels.forEach((m) => console.log(`  - ${m.id}`));

    // At least one model should have thinking (Qwen3.6-35B-A3B-4bit has thinking_default:true)
    expect(thinkingModels.length).toBeGreaterThan(0);
  });
});
