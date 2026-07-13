/**
 * Conformance test for the llama.cpp (llama-server) adapter.
 */

import { describe, expect, it } from "vitest";
import { runConformance } from "../conformance/run-conformance.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { llamacppFixture } from "./llamacpp.fixture.ts";
import { llamacppAdapter } from "../../src/adapters/llamacpp.ts";
import type { DiscoveredServer, ProbeResult } from "../../src/core/types.ts";

runConformance([llamacppFixture]);

const SERVER: DiscoveredServer = {
  kind: "llamacpp",
  baseUrl: "http://127.0.0.1:8080",
  auth: "none",
  label: "llama.cpp (127.0.0.1:8080)",
  confidence: 0.9,
};

function ok(json: unknown): ProbeResult {
  return {
    status: 200,
    ok: true,
    headers: { "content-type": "application/json" },
    json,
  };
}

async function listModels(models: unknown[], props: unknown) {
  return llamacppAdapter.listModels(
    SERVER,
    { mode: "none" },
    createFakeProbe({
      "/v1/models": ok({ data: models }),
      "/props": ok(props),
    }),
  );
}

describe("llama.cpp reported model limits", () => {
  it.each([
    { args: ["-c", "32001", "-n", "2001"], contextWindow: 32001, maxTokens: 2001 },
    { args: ["-c=32002", "-n=2002"], contextWindow: 32002, maxTokens: 2002 },
    { args: ["--ctx-size", "32003", "--predict", "2003"], contextWindow: 32003, maxTokens: 2003 },
    { args: ["--ctx-size=32004", "--predict=2004"], contextWindow: 32004, maxTokens: 2004 },
    { args: ["-c", "32005", "--n-predict", "2005"], contextWindow: 32005, maxTokens: 2005 },
    { args: ["-c=32006", "--n-predict=2006"], contextWindow: 32006, maxTokens: 2006 },
  ])("parses router status args $args when root props contains dummy zeroes", async ({
    args,
    contextWindow,
    maxTokens,
  }) => {
    const [model] = await listModels(
      [{
        id: "router-model",
        meta: { n_ctx: null, n_ctx_train: 131072 },
        status: { args },
      }],
      {
        default_generation_settings: {
          n_ctx: 0,
          params: { n_predict: 0, max_tokens: 0 },
          n_predict: 0,
        },
      },
    );

    expect(model?.contextWindow).toBe(contextWindow);
    expect(model?.maxTokens).toBe(maxTokens);
  });

  it.each([
    {
      name: "uses later equals-form aliases after adjacent occurrences",
      args: [
        "-c",
        "8192",
        "--ctx-size=32768",
        "-n",
        "1024",
        "--predict",
        "2048",
        "--n-predict=4096",
      ],
      contextWindow: 32768,
      maxTokens: 4096,
    },
    {
      name: "uses later adjacent aliases after equals-form occurrences",
      args: [
        "--ctx-size=32769",
        "-c",
        "16385",
        "--n-predict=4097",
        "--predict=3073",
        "-n",
        "2049",
      ],
      contextWindow: 16385,
      maxTokens: 2049,
    },
    {
      name: "keeps preceding valid values after invalid adjacent tails",
      args: [
        "--ctx-size=32770",
        "--n-predict=4098",
        "-c",
        "invalid",
        "-n",
        "invalid",
      ],
      contextWindow: 32770,
      maxTokens: 4098,
    },
    {
      name: "consumes flag-looking tokens as invalid adjacent values",
      args: [
        "--ctx-size=32771",
        "--n-predict=4099",
        "-c",
        "--ctx-size=65536",
        "-n",
        "--predict=8192",
      ],
      contextWindow: 32771,
      maxTokens: 4099,
    },
  ])("$name", async ({ args, contextWindow, maxTokens }) => {
    const [model] = await listModels(
      [{
        id: "repeated-alias-model",
        meta: { n_ctx: null, n_ctx_train: 131072 },
        status: { args },
      }],
      {
        default_generation_settings: {
          n_ctx: 0,
          params: { n_predict: 0, max_tokens: 0 },
          n_predict: 0,
        },
      },
    );

    expect(model?.contextWindow).toBe(contextWindow);
    expect(model?.maxTokens).toBe(maxTokens);
  });

  it("prefers router status context over conflicting positive root props", async () => {
    const [model] = await listModels(
      [{
        id: "router-model",
        meta: { n_ctx: null, n_ctx_train: 131072 },
        status: { args: ["--ctx-size", "32768"] },
      }],
      {
        default_generation_settings: {
          n_ctx: 49152,
        },
      },
    );

    expect(model?.contextWindow).toBe(32768);
  });

  it("prefers the loaded runtime context and status prediction limit", async () => {
    const [model] = await listModels(
      [{
        id: "loaded-model",
        meta: { n_ctx: 65536, n_ctx_train: 131072 },
        status: { args: ["--ctx-size", "32768", "--n-predict=4097"] },
      }],
      {
        default_generation_settings: {
          n_ctx: 49152,
          params: { n_predict: 2048 },
        },
      },
    );

    expect(model?.contextWindow).toBe(65536);
    expect(model?.maxTokens).toBe(4097);
  });

  it("prefers effective single-server root props over training context", async () => {
    const [model] = await listModels(
      [{
        id: "single-server-model",
        meta: { n_ctx: null, n_ctx_train: 131072 },
        status: null,
      }],
      {
        default_generation_settings: {
          n_ctx: 24576,
          params: { n_predict: 6144, max_tokens: 3072 },
          n_predict: 1024,
        },
      },
    );

    expect(model?.contextWindow).toBe(24576);
    expect(model?.maxTokens).toBe(6144);
  });

  it("ignores zero, non-integer, and unsafe candidates before valid fallbacks", async () => {
    const [model] = await listModels(
      [{
        id: "fallthrough-model",
        meta: { n_ctx: Number.MAX_SAFE_INTEGER + 1, n_ctx_train: 65536 },
        status: {
          args: [
            "--ctx-size=-1",
            "--ctx-size",
            String(Number.MAX_SAFE_INTEGER + 1),
            "--n-predict=1.5",
          ],
        },
      }],
      {
        default_generation_settings: {
          n_ctx: 0,
          params: { n_predict: -1, max_tokens: 3072 },
          n_predict: 2048,
        },
      },
    );

    expect(model?.contextWindow).toBe(65536);
    expect(model?.maxTokens).toBe(3072);
  });

  it("supports the legacy direct props n_predict shape", async () => {
    const [model] = await listModels(
      [{ id: "legacy-model", meta: null, status: null }],
      {
        default_generation_settings: {
          n_ctx: null,
          params: null,
          n_predict: 1536,
        },
      },
    );

    expect(model).not.toHaveProperty("contextWindow");
    expect(model?.maxTokens).toBe(1536);
  });

  it("omits both limits when no authoritative positive values exist", async () => {
    const [model] = await listModels(
      [{
        id: "unknown-limits",
        meta: { n_ctx: 0, n_ctx_train: null },
        status: { args: ["-c", "0", "--predict=invalid"] },
      }],
      {
        default_generation_settings: {
          n_ctx: null,
          params: { n_predict: null, max_tokens: 0 },
          n_predict: -1,
        },
      },
    );

    expect(model).toEqual({
      id: "unknown-limits",
      name: "unknown-limits",
      input: ["text"],
      reasoning: false,
    });
  });
});

describe("llama.cpp Pi model limits", () => {
  it("uses the Pi-boundary sentinels for absent or non-positive descriptor limits", () => {
    const absent = llamacppAdapter.toPiModel(SERVER, {
      id: "absent",
      name: "absent",
      input: ["text"],
    });
    const nonPositive = llamacppAdapter.toPiModel(SERVER, {
      id: "non-positive",
      name: "non-positive",
      input: ["text"],
      contextWindow: 0,
      maxTokens: -1,
    });

    expect(absent.contextWindow).toBe(128_000);
    expect(absent.maxTokens).toBe(0);
    expect(nonPositive.contextWindow).toBe(128_000);
    expect(nonPositive.maxTokens).toBe(0);
  });

  it("passes positive safe descriptor limits through unchanged", () => {
    const entry = llamacppAdapter.toPiModel(SERVER, {
      id: "known",
      name: "known",
      input: ["text"],
      contextWindow: 98304,
      maxTokens: 12288,
    });

    expect(entry.contextWindow).toBe(98304);
    expect(entry.maxTokens).toBe(12288);
  });
});
