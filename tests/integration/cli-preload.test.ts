/**
 * CLI integration tests for programmatic provider preload (factory registration from cache).
 *
 * Uses an isolated PI_CODING_AGENT_DIR (never the user's real ~/.pi), writes
 * crossbar.json (and optionally auth.json) with a cached enabled server, and
 * spawns the local `pi` binary with `--extension` pointing at our src/index.ts
 * (TS is supported). Focuses on --list-models / --offline / print-mode behavior
 * that can be validated purely from the preload cache.
 *
 * Full end-to-end `-p "Reply with OK"` is skipped per plan: it requires a live
 * reachable backend.
 *
 * These tests deliberately avoid network calls from Crossbar preload itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const PI_BIN = resolve(process.cwd(), "node_modules/.bin/pi");
const EXT_PATH = resolve(process.cwd(), "src/index.ts");

let agentDir: string;

function makeAgentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "crossbar-it-preload-"));
  mkdirSync(d, { recursive: true });
  return d;
}

function writeCrossbarJson(dir: string, servers: unknown[]): void {
  const cfg = { version: 1, servers };
  writeFileSync(join(dir, "crossbar.json"), JSON.stringify(cfg, null, 2), "utf8");
}

function writeAuthJson(dir: string, entries: Record<string, unknown>): void {
  // Shape consumed by AuthStorage.create(join(dir, "auth.json"))
  writeFileSync(join(dir, "auth.json"), JSON.stringify(entries, null, 2), "utf8");
}

function runPi(args: string[], envExtra: Record<string, string> = {}) {
  const res = spawnSync(PI_BIN, args, {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      // Reduce noise and make output stable
      NO_COLOR: "1",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "0",
      ...envExtra,
    },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    output: (res.stdout ?? "") + "\n" + (res.stderr ?? ""),
  };
}

const chatModel = {
  id: "llama3:8b",
  name: "Llama 3 8B",
  contextWindow: 8192,
  maxTokens: 4096,
  input: ["text"],
  reasoning: false,
  tools: true,
  embeddings: false,
};

const ollamaNoAuth = {
  id: "crossbar-ollama-127-0-0-1-11434",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  label: "Ollama (127.0.0.1:11434)",
  auth: "none",
  enabled: true,
  addedAt: 1719000000000,
  lastKnownModels: [chatModel],
};

const keyedRecord = {
  id: "crossbar-testkeyed",
  kind: "openai-generic",
  baseUrl: "http://127.0.0.1:9999",
  label: "TestKeyed",
  auth: "apiKey",
  enabled: true,
  addedAt: 1719000000000,
  lastKnownModels: [
    {
      id: "test-model",
      name: "Test Model",
      contextWindow: 4096,
      maxTokens: 1024,
      input: ["text"],
      reasoning: false,
      tools: false,
      embeddings: false,
    },
  ],
};

describe("[integration] programmatic preload via CLI", () => {
  beforeEach(() => {
    agentDir = makeAgentDir();
  });

  afterEach(() => {
    if (agentDir) {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("--list-models includes the cached model from factory preload", () => {
    writeCrossbarJson(agentDir, [ollamaNoAuth]);

    const { status, output } = runPi(["--extension", EXT_PATH, "--list-models", "crossbar", "--no-session"]);

    // Should succeed and surface our cached model (id or label may appear)
    expect(status).toBe(0);
    expect(output).toMatch(/llama3:8b|Ollama.*127|crossbar-ollama/);
    // Preload must have prevented the stock warning
    expect(output).not.toMatch(/No models available/i);
  });

  it("--offline --list-models includes the cached model (no network from preload)", () => {
    writeCrossbarJson(agentDir, [ollamaNoAuth]);

    const { status, output } = runPi(
      ["--extension", EXT_PATH, "--offline", "--list-models", "crossbar", "--no-session"],
    );

    expect(status).toBe(0);
    expect(output).toMatch(/llama3:8b|Ollama.*127|crossbar-ollama/);
    expect(output).not.toMatch(/No models available/i);
  });

  // Guarded/skipped: the full --print -p round-trip + explicit --model resolution triggers
  // an inference attempt against the (unreachable) cached baseUrl. This can hang or take
  // >5s even with --offline (network is only avoided by preload itself, not the eventual call).
  // Per plan: "the full -p 'Reply with OK' round-trip needs a live model server — guard/skip
  // that part".  --list-models (above) + offline already prove the preload registration works
  // and that "No models available" is not emitted when a usable cached model exists.
  it.skip("print mode does not emit 'No models available' when a usable cached model exists (requires live backend)", () => {
    writeCrossbarJson(agentDir, [ollamaNoAuth]);
    const { output } = runPi(
      [
        "--extension",
        EXT_PATH,
        "--print",
        "-p",
        "hello",
        "--model",
        `${ollamaNoAuth.id}/${chatModel.id}`,
        "--no-session",
        "--offline",
      ],
      {},
    );
    expect(output).not.toMatch(/No models available/i);
  });

  it("keyed-without-key is registered but unavailable and does not crash the process", () => {
    writeCrossbarJson(agentDir, [keyedRecord]);
    // No entry in auth.json for keyedRecord.id — intentionally missing credential

    const { status, output } = runPi(["--extension", EXT_PATH, "--list-models", "--no-session"]);

    // Must not crash / throw during factory or model resolution
    // (status may be non-zero due to no models overall, but no uncaught exception)
    expect(output).not.toMatch(/Error|exception|crash|API key missing/i);
    // The specific model should not be treated as available (no key)
    expect(output).not.toMatch(/test-model|TestKeyed/i);
  });
});
