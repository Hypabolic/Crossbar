/**
 * Conformance test for the llama-swap adapter.
 */

import { describe, expect, it } from "vitest";

import { llamaswapAdapter } from "../../src/adapters/llamaswap.ts";
import type { DiscoveredServer, Probe, ProbeInit } from "../../src/core/types.ts";
import { createFakeProbe } from "../conformance/fake-probe.ts";
import { runConformance } from "../conformance/run-conformance.ts";
import { llamaswapFixture } from "./llamaswap.fixture.ts";

runConformance([llamaswapFixture]);

const SERVER: DiscoveredServer = {
  kind: "llamaswap",
  baseUrl: "http://127.0.0.1:8080",
  auth: "none",
  label: "llama-swap",
  confidence: 0.9,
};

function modelsProbe(data: unknown[]): { probe: Probe; paths: string[] } {
  const paths: string[] = [];
  const fakeProbe = createFakeProbe({
    "/v1/models": {
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      json: { data },
    },
  });
  const probe = async (path: string, init?: ProbeInit) => {
    paths.push(path);
    return fakeProbe(path, init);
  };
  return { probe, paths };
}

describe("llamaswap model limits", () => {
  it("keeps a positive safe top-level context_length without inventing maxTokens", async () => {
    const { probe, paths } = modelsProbe([
      {
        id: "configured-context",
        context_length: 32_768,
        meta: null,
      },
    ]);

    const models = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models).toHaveLength(1);
    expect(models[0]?.contextWindow).toBe(32_768);
    expect(models[0]).not.toHaveProperty("maxTokens");
    expect(paths).toEqual(["/v1/models"]);
  });

  it("omits missing, non-positive, and invalid context_length values", async () => {
    const { probe } = modelsProbe([
      { id: "missing" },
      { id: "null", context_length: null },
      { id: "zero", context_length: 0 },
      { id: "negative", context_length: -1 },
      { id: "fractional", context_length: 4096.5 },
      { id: "unsafe", context_length: Number.MAX_SAFE_INTEGER + 1 },
      { id: "string", context_length: "8192" },
    ]);

    const models = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models.map((model) => model.id)).toEqual([
      "missing",
      "null",
      "zero",
      "negative",
      "fractional",
      "unsafe",
      "string",
    ]);
    for (const model of models) {
      expect(model).not.toHaveProperty("contextWindow");
      expect(model).not.toHaveProperty("maxTokens");
    }
  });

  it("ignores context- and output-looking values in arbitrary llama-swap metadata", async () => {
    const { probe, paths } = modelsProbe([
      {
        id: "metadata-only",
        meta: {
          llamaswap: {
            context_length: 65_536,
            contextWindow: 65_536,
            max_tokens: 4096,
            maxTokens: 4096,
            n_predict: 4096,
          },
        },
      },
    ]);

    const models = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(models[0]).not.toHaveProperty("contextWindow");
    expect(models[0]).not.toHaveProperty("maxTokens");
    expect(paths).toEqual(["/v1/models"]);
  });
});

describe("llamaswap typed model metadata", () => {
  it("maps a rich valid model row", async () => {
    const { probe, paths } = modelsProbe([
      {
        id: "rich-model",
        name: "  Rich Vision Model  ",
        architecture: {
          input_modalities: ["text", "image"],
        },
        capabilities: {
          vision: false,
          function_calling: true,
        },
        supported_parameters: ["tool_choice"],
        status: { value: "loaded" },
        context_length: 65_536,
      },
    ]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.id).toBe("rich-model");
    expect(model?.name).toBe("Rich Vision Model");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.tools).toBe(true);
    expect(model?.loaded).toBe(true);
    expect(model?.reasoning).toBe(false);
    expect(model?.contextWindow).toBe(65_536);
    expect(paths).toEqual(["/v1/models"]);
  });

  it.each([
    {
      label: "absent",
      entry: { id: "name-absent" },
      expectedName: "name-absent",
    },
    {
      label: "blank",
      entry: { id: "name-blank", name: " \t " },
      expectedName: "name-blank",
    },
    {
      label: "non-string",
      entry: { id: "name-non-string", name: 42 },
      expectedName: "name-non-string",
    },
  ])("falls back to the id when name is $label", async ({ entry, expectedName }) => {
    const { probe } = modelsProbe([entry]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.name).toBe(expectedName);
  });

  it.each([
    {
      label: "text-only modalities override the vision fallback",
      entry: {
        id: "modalities-text",
        architecture: { input_modalities: ["text"] },
        capabilities: { vision: true },
      },
      expectedInput: ["text"],
    },
    {
      label: "an exact image modality enables image input",
      entry: {
        id: "modalities-image",
        architecture: { input_modalities: ["text", "image"] },
        capabilities: { vision: false },
      },
      expectedInput: ["text", "image"],
    },
    {
      label: "vision is used when modalities are absent",
      entry: {
        id: "vision-fallback",
        capabilities: { vision: true },
      },
      expectedInput: ["text", "image"],
    },
    {
      label: "vision is used when modalities are not an array",
      entry: {
        id: "malformed-modalities-fallback",
        architecture: { input_modalities: "image" },
        capabilities: { vision: true },
      },
      expectedInput: ["text", "image"],
    },
    {
      label: "a string modality is ignored when vision is false",
      entry: {
        id: "malformed-modalities-string",
        architecture: { input_modalities: "image" },
        capabilities: { vision: false },
      },
      expectedInput: ["text"],
    },
    {
      label: "an object modality is ignored when vision is false",
      entry: {
        id: "malformed-modalities-object",
        architecture: { input_modalities: { image: true } },
        capabilities: { vision: false },
      },
      expectedInput: ["text"],
    },
    {
      label: "a malformed modalities array remains authoritative",
      entry: {
        id: "malformed-modalities-array",
        architecture: { input_modalities: ["Image", "vision", 3, null] },
        capabilities: { vision: true },
      },
      expectedInput: ["text"],
    },
    {
      label: "an exact image survives malformed sibling modalities",
      entry: {
        id: "mixed-modalities-array",
        architecture: { input_modalities: [null, "image", 3] },
        capabilities: { vision: false },
      },
      expectedInput: ["text", "image"],
    },
    {
      label: "vision is used when architecture is malformed",
      entry: {
        id: "malformed-architecture",
        architecture: null,
        capabilities: { vision: true },
      },
      expectedInput: ["text", "image"],
    },
    {
      label: "a non-boolean vision value is ignored",
      entry: {
        id: "malformed-vision",
        capabilities: { vision: "true" },
      },
      expectedInput: ["text"],
    },
  ])("$label", async ({ entry, expectedInput }) => {
    const { probe } = modelsProbe([entry]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.input).toEqual(expectedInput);
  });

  it.each([
    {
      label: "boolean function_calling enables tools",
      entry: {
        id: "function-calling",
        capabilities: { function_calling: true },
      },
      expectedTools: true,
    },
    {
      label: "supported_parameters provides the tools fallback",
      entry: {
        id: "supported-tools",
        supported_parameters: ["temperature", "tools"],
      },
      expectedTools: true,
    },
    {
      label: "explicit false overrides supported_parameters",
      entry: {
        id: "explicit-no-tools",
        capabilities: { function_calling: false },
        supported_parameters: ["tools"],
      },
      expectedTools: undefined,
    },
    {
      label: "tool_choice alone does not enable tools",
      entry: {
        id: "tool-choice-only",
        supported_parameters: ["tool_choice"],
      },
      expectedTools: undefined,
    },
    {
      label: "malformed function_calling falls back to supported_parameters",
      entry: {
        id: "malformed-function-fallback",
        capabilities: { function_calling: "true" },
        supported_parameters: ["tools"],
      },
      expectedTools: true,
    },
    {
      label: "malformed function_calling without a fallback is ignored",
      entry: {
        id: "malformed-function",
        capabilities: { function_calling: "true" },
      },
      expectedTools: undefined,
    },
    {
      label: "a string supported_parameters value is ignored",
      entry: {
        id: "malformed-supported-parameters",
        supported_parameters: "tools",
      },
      expectedTools: undefined,
    },
    {
      label: "malformed and inexact supported_parameters entries are ignored",
      entry: {
        id: "malformed-supported-entries",
        supported_parameters: ["Tools", 1, null],
      },
      expectedTools: undefined,
    },
    {
      label: "an exact tools entry survives malformed siblings",
      entry: {
        id: "mixed-supported-entries",
        supported_parameters: [null, "tools", 1],
      },
      expectedTools: true,
    },
    {
      label: "supported_parameters survives malformed capabilities",
      entry: {
        id: "malformed-capabilities",
        capabilities: null,
        supported_parameters: ["tools"],
      },
      expectedTools: true,
    },
  ])("$label", async ({ entry, expectedTools }) => {
    const { probe } = modelsProbe([entry]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    if (expectedTools === true) {
      expect(model?.tools).toBe(true);
    } else {
      expect(model).not.toHaveProperty("tools");
    }
  });

  it.each([
    {
      label: "loaded",
      entry: { id: "loaded", status: { value: "loaded" } },
      expectedLoaded: true,
    },
    {
      label: "unloaded",
      entry: { id: "unloaded", status: { value: "unloaded" } },
      expectedLoaded: false,
    },
    {
      label: "an unknown status",
      entry: { id: "unknown-status", status: { value: "loading" } },
      expectedLoaded: undefined,
    },
    {
      label: "a non-string status value",
      entry: { id: "malformed-status-value", status: { value: 1 } },
      expectedLoaded: undefined,
    },
    {
      label: "a malformed status object",
      entry: { id: "malformed-status", status: "loaded" },
      expectedLoaded: undefined,
    },
    {
      label: "a missing status",
      entry: { id: "missing-status" },
      expectedLoaded: undefined,
    },
  ])("maps $label safely", async ({ entry, expectedLoaded }) => {
    const { probe } = modelsProbe([entry]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    if (expectedLoaded === undefined) {
      expect(model).not.toHaveProperty("loaded");
    } else {
      expect(model?.loaded).toBe(expectedLoaded);
    }
  });

  it("keeps reasoning false despite reasoning-looking fields", async () => {
    const { probe } = modelsProbe([
      {
        id: "bogus-reasoning",
        reasoning: true,
        architecture: { reasoning: true },
        capabilities: { reasoning: true, thinking: true },
        meta: {
          reasoning: true,
          capabilities: { reasoning: true },
        },
      },
    ]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.reasoning).toBe(false);
  });

  it("keeps context_length unchanged alongside typed metadata", async () => {
    const { probe } = modelsProbe([
      {
        id: "context-with-metadata",
        name: "  Context Model  ",
        context_length: 32_768,
        architecture: { input_modalities: ["image"] },
        capabilities: { function_calling: true },
        status: { value: "unloaded" },
      },
    ]);

    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model?.name).toBe("Context Model");
    expect(model?.contextWindow).toBe(32_768);
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.tools).toBe(true);
    expect(model?.loaded).toBe(false);
  });

  it("forwards display name and image input to Pi without descriptor-only metadata", async () => {
    const { probe } = modelsProbe([
      {
        id: "pi-metadata",
        name: "  Pi Vision Model  ",
        architecture: { input_modalities: ["image"] },
        capabilities: { function_calling: true },
        status: { value: "loaded" },
      },
    ]);
    const [model] = await llamaswapAdapter.listModels(SERVER, { mode: "none" }, probe);

    expect(model).toBeDefined();
    const piModel = llamaswapAdapter.toPiModel(SERVER, model!);

    expect(piModel.name).toBe("Pi Vision Model");
    expect(piModel.input).toEqual(["text", "image"]);
    expect(piModel).not.toHaveProperty("tools");
    expect(piModel).not.toHaveProperty("loaded");
  });
});

describe("llamaswap Pi model limits", () => {
  it("uses only the 128000/0 registration fallback when limits are missing", () => {
    const piModel = llamaswapAdapter.toPiModel(SERVER, {
      id: "unknown-limits",
      name: "unknown-limits",
      input: ["text"],
    });

    expect(piModel.contextWindow).toBe(128_000);
    expect(piModel.maxTokens).toBe(0);
  });

  it("uses the registration fallback for non-positive limits", () => {
    const piModel = llamaswapAdapter.toPiModel(SERVER, {
      id: "non-positive-limits",
      name: "non-positive-limits",
      input: ["text"],
      contextWindow: 0,
      maxTokens: -1,
    });

    expect(piModel.contextWindow).toBe(128_000);
    expect(piModel.maxTokens).toBe(0);
  });

  it("passes through positive descriptor limits exactly", () => {
    const piModel = llamaswapAdapter.toPiModel(SERVER, {
      id: "known-limits",
      name: "known-limits",
      input: ["text"],
      contextWindow: 65_536,
      maxTokens: 3072,
    });

    expect(piModel.contextWindow).toBe(65_536);
    expect(piModel.maxTokens).toBe(3072);
  });
});
