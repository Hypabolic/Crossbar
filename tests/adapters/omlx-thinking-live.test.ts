/** Live test: verify oMLX thinking capability is parsed from /v1/models/status */
import { describe, it, expect } from "vitest";
import { omlxAdapter } from "../../src/adapters/omlx.ts";

/**
 * Live test: verify oMLX thinking capability is parsed from /v1/models/status.
 *
 * Run with: LIVE_TEST=1 npx vitest run tests/adapters/omlx-thinking-live.test.ts
 * Skipped by default (no network).
 */
describe.skipIf(!process.env.LIVE_TEST)("oMLX thinking capability (live)", () => {
  const baseUrl = "http://127.0.0.1:8000";

  const probe = async (path: string, init?: { method?: string; headers?: Record<string,string> }) => {
    const r = await fetch(baseUrl + path, init ? { method: init.method, headers: init.headers } : undefined);
    const text = await r.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers.entries()), json };
  };

  it("parses thinking_default as reasoning from status endpoint", async () => {
    const server = await omlxAdapter.fingerprint(baseUrl, probe as any);
    expect(server).not.toBeNull();
    if (!server) return;

    const models = await omlxAdapter.listModels(server, { mode: "none" }, probe as any);
    
    // Models with thinking_default:true should have reasoning=true
    const thinkingModels = models.filter(m => m.reasoning);
    const nonThinkingModels = models.filter(m => !m.reasoning);

    console.log(`Total: ${models.length}, Thinking: ${thinkingModels.length}, Non-thinking: ${nonThinkingModels.length}`);
    thinkingModels.forEach(m => console.log(`  ✓ ${m.id}`));
    nonThinkingModels.forEach(m => console.log(`  - ${m.id}`));

    // At least one model should have thinking (Qwen3.6-35B-A3B-4bit has thinking_default:true)
    expect(thinkingModels.length).toBeGreaterThan(0);
  });
});
