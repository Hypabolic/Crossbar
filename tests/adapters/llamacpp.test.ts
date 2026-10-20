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
    // A pinned launch arg is the declared window — provenance must say so.
    expect(model?.contextWindowSource).toBe("declared");
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

  it("declared pin beats a conflicting loaded runtime context (precedence ladder)", async () => {
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

    // A non-fitting pin would be a hard load failure, so in practice pin and loaded
    // context agree — declared-first is the safe direction in the artificial conflict.
    expect(model?.contextWindow).toBe(32768);
    expect(model?.contextWindowSource).toBe("declared");
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
    // The single-server runtime default is a live observation.
    expect(model?.contextWindowSource).toBe("observed");
    expect(model?.maxTokens).toBe(6144);
  });

  it("ignores zero, non-integer, and unsafe candidates — the trained ceiling is not a window", async () => {
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

    // No declared or observed window exists — n_ctx_train 65536 is a trained
    // ceiling: informational only, never a serviceable window.
    expect(model).not.toHaveProperty("contextWindow");
    expect(model).not.toHaveProperty("contextWindowSource");
    expect(model?.trainedMax).toBe(65536);
    expect(model?.maxTokens).toBe(3072);
  });

  it("reports the trained ceiling as informational trainedMax alongside an observed window", async () => {
    const [model] = await listModels(
      [{
        id: "qwen-incident",
        meta: { n_ctx: 234496, n_ctx_train: 262144 },
        status: null,
      }],
      {
        default_generation_settings: { n_ctx: null },
      },
    );

    expect(model?.contextWindow).toBe(234496);
    expect(model?.contextWindowSource).toBe("observed");
    expect(model?.trainedMax).toBe(262144);
  });

  it("reports no window for an unloaded router row whose only context is the trained ceiling (incident)", async () => {
    const [model] = await listModels(
      [{
        id: "unsloth/Qwen3.8-27B-GGUF",
        meta: { n_ctx: null, n_ctx_train: 262144 },
        status: { args: [] },
      }],
      {
        default_generation_settings: { n_ctx: 0 },
      },
    );

    // The Qwen3.8-27B incident: unloaded, no -c pin, trained ceiling 262144.
    // The descriptor must assert nothing — and the Pi entry gets the uniform
    // boundary fallback, never the trained ceiling.
    expect(model).not.toHaveProperty("contextWindow");
    expect(model).not.toHaveProperty("contextWindowSource");
    expect(model?.trainedMax).toBe(262144);
    expect(llamacppAdapter.toPiModel(SERVER, model!).contextWindow).toBe(8192);
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

describe("llama.cpp vision detection (/props modalities)", () => {
  it.each([
    {
      name: "object map with vision enabled (live llama-server shape)",
      props: { modalities: { vision: true, video: true, audio: false } },
      expected: ["text", "image"],
    },
    {
      name: "object map with vision disabled",
      props: { modalities: { vision: false, video: false, audio: false } },
      expected: ["text"],
    },
    {
      name: "object map using an image key",
      props: { modalities: { image: true } },
      expected: ["text", "image"],
    },
    {
      name: "legacy string array with an image entry",
      props: { modalities: ["text", "image"] },
      expected: ["text", "image"],
    },
    {
      name: "legacy string array with a vision entry",
      props: { modalities: ["text", "vision"] },
      expected: ["text", "image"],
    },
    {
      name: "text-only string array",
      props: { modalities: ["text"] },
      expected: ["text"],
    },
    {
      name: "missing modalities field",
      props: {},
      expected: ["text"],
    },
  ])("$name", async ({ props, expected }) => {
    const [model] = await listModels(
      [{ id: "vision-check", meta: null, status: null }],
      props,
    );
    expect(model?.input).toEqual(expected);
  });

  it("does not copy root /props vision onto router rows", async () => {
    const models = await listModels(
      [
        { id: "vlm", status: { value: "loaded" } },
        { id: "text", status: { value: "unloaded" } },
      ],
      { modalities: { vision: true } },
    );
    expect(models.map((model) => model.input)).toEqual([["text"], ["text"]]);
  });

  it("keeps per-model vision on a router catalogue and ignores root /props", async () => {
    const models = await listModels(
      [
        {
          id: "vlm",
          status: { value: "unloaded", args: [] },
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "text-only",
          status: { value: "loaded", args: ["-c", "8192"] },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "legacy",
          status: { value: "unloaded", args: [] },
        },
      ],
      { role: "router", model_path: "none", modalities: { vision: true } },
    );

    expect(models.map((model) => [model.id, model.input])).toEqual([
      ["vlm", ["text", "image"]],
      ["text-only", ["text"]],
      ["legacy", ["text"]],
    ]);
  });
});

describe("llama.cpp Pi model limits", () => {
  it("uses the uniform 8192 boundary fallback for absent or non-positive descriptor limits", () => {
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

    expect(absent.contextWindow).toBe(8192);
    expect(absent.maxTokens).toBe(0);
    expect(nonPositive.contextWindow).toBe(8192);
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
