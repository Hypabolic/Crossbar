/**
 * Conformance tests for the Unsloth Studio backend adapter.
 *
 * Delegates the standard contract checks to the shared conformance harness, then adds
 * adapter-specific coverage for the discriminator that actually motivated this adapter:
 * identifying Unsloth Studio from its `Server: unsloth-studio` response header even when no
 * working API key is in hand yet, and declaring `authRequired` so onboarding can't offer a
 * "No authentication" option for it.
 */

import { describe, it, expect } from "vitest";

import { runConformance } from "../conformance/run-conformance.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { unslothAdapter } from "../../src/adapters/unsloth.ts";
import { unslothFixture } from "./unsloth.fixture.ts";

runConformance([unslothFixture]);

describe("[unsloth] adapter-specific", () => {
  it("declares authRequired — this backend has no unauthenticated mode", () => {
    expect(unslothAdapter.authRequired).toBe(true);
  });

  it("identifies the server from the Server header alone, even on an unauthenticated 401", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 401,
        ok: false,
        headers: { server: "unsloth-studio", "www-authenticate": "Bearer" },
        json: { error: { message: "Not authenticated", type: "authentication_error" } },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("unsloth");
    expect(result?.auth).toBe("apiKey");
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  it("matches the Server header value case-insensitively", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 401,
        ok: false,
        headers: { server: "Unsloth-Studio" },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result?.kind).toBe("unsloth");
  });

  it("does NOT claim a 401 from a different backend lacking the Server header", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 401,
        ok: false,
        headers: { "content-type": "application/json" },
        json: { error: "Unauthorized" },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).toBeNull();
  });

  it("does NOT claim a 200 + data[] response lacking the Server header, no matter how plausible", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: { object: "list", data: [{ id: "totally-plausible-model", owned_by: "unsloth-studio" }] },
      },
    });
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).toBeNull();
  });

  it("returns null on connection refused (status 0)", async () => {
    const probe = createFakeProbe({});
    const result = await unslothAdapter.fingerprint("http://127.0.0.1:8888", probe);
    expect(result).toBeNull();
  });

  it("introspectLoaded reports only models with loaded: true", async () => {
    const probe = createFakeProbe({
      "/v1/models": {
        status: 200,
        ok: true,
        headers: { server: "unsloth-studio" },
        json: {
          data: [
            { id: "a", owned_by: "unsloth-studio", loaded: true },
            { id: "b", owned_by: "unsloth-studio", loaded: false },
          ],
        },
      },
    });
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    const result = await unslothAdapter.introspectLoaded?.(server, { mode: "apiKey", apiKey: "k" }, probe);
    expect(result?.loadedModelIds).toEqual(["a"]);
    expect(result?.source).toBe("introspection");
  });

  it("inferenceBaseUrl appends /v1 exactly once", () => {
    const server = {
      kind: "unsloth" as const,
      baseUrl: "http://127.0.0.1:8888",
      auth: "apiKey" as const,
      label: "Unsloth Studio",
      confidence: 0.95,
    };
    expect(unslothAdapter.inferenceBaseUrl(server)).toBe("http://127.0.0.1:8888/v1");
    expect(unslothAdapter.inferenceBaseUrl({ ...server, baseUrl: "http://127.0.0.1:8888/v1" })).toBe(
      "http://127.0.0.1:8888/v1",
    );
  });
});
