#!/usr/bin/env node
/**
 * Fake LM Studio server — a dependency-free stub of LM Studio's local API, for
 * demos and manual testing of Crossbar without a real LM Studio install.
 *
 * It implements just enough of the surface the LM Studio adapter
 * (src/adapters/lmstudio.ts) probes, plus an OpenAI-compatible chat endpoint so
 * Pi can actually talk to it end-to-end:
 *
 *   GET  /api/v1/models            native model list (state, compatibility_type,
 *                                   max_context_length, loaded_context_length …)
 *   POST /api/v1/models/load       mark a model "loaded" (with a loaded ctx window)
 *   POST /api/v1/models/unload     mark a model "not-loaded"
 *   GET  /v1/models                OpenAI-compat model list
 *   POST /v1/chat/completions      OpenAI-compat chat (stream + non-stream), with
 *                                   usage.prompt_tokens_details.cached_tokens so the
 *                                   cache-hit reporting path is exercised too.
 *
 * Usage:
 *   node scripts/fake-lmstudio.mjs            # listens on :1234 (LM Studio default)
 *   PORT=1235 node scripts/fake-lmstudio.mjs
 *
 * The `state` + `compatibility_type` fields are what Crossbar fingerprints on, so a
 * running instance is auto-discovered by `/crossbar` on localhost.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 1234);

/** In-memory model catalogue. Note the deliberate loaded-vs-max ctx split. */
const MODELS = [
  {
    id: "qwen2.5-coder-7b-instruct",
    type: "llm",
    state: "loaded",
    compatibility_type: "gguf",
    max_context_length: 32768,
    // Loaded with a smaller operative window than the model ceiling — Crossbar
    // registers THIS value with Pi (see the operative-context-window fix).
    loaded_context_length: 16384,
    quantization: "Q4_K_M",
    arch: "qwen2",
  },
  {
    id: "llama-3.2-3b-instruct",
    type: "llm",
    state: "not-loaded",
    compatibility_type: "gguf",
    max_context_length: 131072,
    loaded_context_length: 0,
    quantization: "Q4_K_M",
    arch: "llama",
  },
  {
    id: "llava-1.5-7b",
    type: "vlm",
    state: "not-loaded",
    compatibility_type: "gguf",
    max_context_length: 8192,
    loaded_context_length: 0,
    quantization: "Q4_K_M",
    arch: "llava",
  },
  {
    id: "nomic-embed-text-v1.5",
    type: "embeddings",
    state: "not-loaded",
    compatibility_type: "gguf",
    max_context_length: 2048,
    loaded_context_length: 0,
    quantization: "F16",
    arch: "nomic-bert",
  },
];

const findModel = (id) => MODELS.find((m) => m.id === id);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  process.stdout.write(`${method} ${path}\n`);

  // ── Native LM Studio API ──────────────────────────────────────────────────
  if (method === "GET" && path === "/api/v1/models") {
    return json(res, 200, { data: MODELS });
  }

  if (method === "POST" && (path === "/api/v1/models/load" || path === "/api/v1/models/unload")) {
    const body = await readBody(req);
    const model = findModel(body.model);
    if (!model) return json(res, 404, { error: `model not found: ${body.model}` });
    if (path.endsWith("/load")) {
      model.state = "loaded";
      model.loaded_context_length = Math.min(16384, model.max_context_length);
    } else {
      model.state = "not-loaded";
      model.loaded_context_length = 0;
    }
    return json(res, 200, { success: true, model: model.id, state: model.state });
  }

  // ── OpenAI-compatible API ─────────────────────────────────────────────────
  if (method === "GET" && path === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "lmstudio" })),
    });
  }

  if (method === "POST" && path === "/v1/chat/completions") {
    const body = await readBody(req);
    const model = body.model ?? MODELS.find((m) => m.state === "loaded")?.id ?? MODELS[0].id;
    const reply = "Hello from the fake LM Studio server — this is a canned reply.";
    // Pretend a chunk of the prompt was served from the prefix cache.
    const promptTokens = 128;
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 14,
      total_tokens: promptTokens + 14,
      prompt_tokens_details: { cached_tokens: 96 },
    };

    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", model };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
      for (const word of reply.split(" ")) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: word + " " } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return json(res, 200, {
      id: "chatcmpl-fake",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage,
    });
  }

  json(res, 404, { error: `not found: ${method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fake LM Studio listening on http://127.0.0.1:${PORT}\n`);
});
