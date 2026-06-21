/**
 * Live discovery validation — exercises the REAL network path (createProbe → node fetch → a real
 * TCP socket), not the fake probe. Spins up minimal HTTP servers that mimic real backends, then runs
 * the real `discoverLocalhost` engine against zero / one / many of them.
 *
 * This is the Phase 3 "validated on machines with zero, one, and many servers" check, automated.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { discoverLocalhost } from "../../src/discovery/engine.ts";
import { createProbe } from "../../src/discovery/probe.ts";
import { DISCOVERY_ADAPTERS, adapterFor } from "../../src/adapters/index.ts";

type Route = { status?: number; json?: unknown; text?: string };
type RouteTable = Record<string, Route>; // key: "METHOD /path"

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
});

/** Start a real HTTP server with a fixed route table; returns its loopback port. */
function startMock(routes: RouteTable): Promise<number> {
  const server = createServer((req, res) => {
    const key = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    const route = routes[key];
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = route.status ?? 200;
    if (route.json !== undefined) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(route.json));
    } else {
      res.setHeader("content-type", "text/plain");
      res.end(route.text ?? "");
    }
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

const OLLAMA_ROUTES: RouteTable = {
  "GET /": { text: "Ollama is running" },
  "GET /api/version": { json: { version: "0.5.0" } },
  "GET /api/tags": { json: { models: [{ name: "llama3.1:8b", model: "llama3.1:8b" }] } },
  "POST /api/show": {
    json: { capabilities: ["completion", "tools"], model_info: { "llama.context_length": 8192 } },
  },
  "GET /api/ps": { json: { models: [{ name: "llama3.1:8b" }] } },
};

const VLLM_ROUTES: RouteTable = {
  "GET /version": { json: { version: "0.6.3" } },
  "GET /v1/models": {
    json: { object: "list", data: [{ id: "Qwen2.5-7B", object: "model", owned_by: "vllm", max_model_len: 32768 }] },
  },
  "GET /health": { status: 200, text: "" },
};

describe("[integration] live discovery over real sockets", () => {
  it("ZERO servers: a swept-but-closed port yields nothing", async () => {
    // Obtain a definitely-free port: open an ephemeral server, read its port, fully close it.
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port));
    });
    await new Promise<void>((res) => probe.close(() => res()));

    const found = await discoverLocalhost([...DISCOVERY_ADAPTERS], { ports: [port], timeoutMs: 400 });
    expect(found).toEqual([]);
  });

  it("ONE server: discovers Ollama and lists its models over the real socket", async () => {
    const port = await startMock(OLLAMA_ROUTES);
    const found = await discoverLocalhost([...DISCOVERY_ADAPTERS], { ports: [port], timeoutMs: 800 });

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("ollama");

    // End-to-end listModels against the live server.
    const server = found[0]!;
    const adapter = adapterFor(server.kind);
    const probe = createProbe(server.baseUrl, { auth: { mode: "none" } });
    const models = await adapter.listModels(server, { mode: "none" }, probe);
    expect(models.map((m) => m.id)).toContain("llama3.1:8b");
  });

  it("MANY servers: discovers Ollama and vLLM on distinct ports with correct kinds", async () => {
    const [ollamaPort, vllmPort] = await Promise.all([startMock(OLLAMA_ROUTES), startMock(VLLM_ROUTES)]);
    const found = await discoverLocalhost([...DISCOVERY_ADAPTERS], {
      ports: [ollamaPort, vllmPort],
      timeoutMs: 800,
    });

    expect(found).toHaveLength(2);
    const byPort = new Map(found.map((s) => [Number(new URL(s.baseUrl).port), s.kind]));
    expect(byPort.get(ollamaPort)).toBe("ollama");
    expect(byPort.get(vllmPort)).toBe("vllm");
  });
});
