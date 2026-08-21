/**
 * Unit tests for the auth.json–backed CredentialStore.
 *
 * This module exists because pi-coding-agent ≥0.80.8 removed the extension-facing
 * `AuthStorage` class (see CHANGELOG "AuthStorage and its storage backends are no longer
 * exported") — `ctx.modelRegistry.authStorage` used to be the write path and is now
 * `undefined`, which crashed Crossbar's original credential store with "Cannot read
 * properties of undefined (reading 'set')". These tests lock in the replacement's contract:
 * read/write auth.json directly, in Pi's own flat shape, without ever touching entries that
 * belong to other providers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuthJsonCredentialStore } from "../../src/registry/auth-json-credential-store.ts";

let dir: string;
let authPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossbar-auth-test-"));
  authPath = join(dir, "auth.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createAuthJsonCredentialStore", () => {
  it("get() returns undefined when auth.json does not exist yet", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    expect(await store.get("crossbar-unsloth-example")).toBeUndefined();
  });

  it("round-trips a key through set() then get()", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    await store.set("crossbar-unsloth-example", "sk-unsloth-abc123");
    expect(await store.get("crossbar-unsloth-example")).toBe("sk-unsloth-abc123");
  });

  it("persists across store instances (survives a process restart)", async () => {
    const first = createAuthJsonCredentialStore({ authPath });
    await first.set("crossbar-unsloth-example", "sk-unsloth-abc123");

    const second = createAuthJsonCredentialStore({ authPath });
    expect(await second.get("crossbar-unsloth-example")).toBe("sk-unsloth-abc123");
  });

  it("writes the exact flat shape Pi's own auth.json uses", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    await store.set("crossbar-unsloth-example", "sk-unsloth-abc123");

    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(raw).toEqual({
      "crossbar-unsloth-example": { type: "api_key", key: "sk-unsloth-abc123" },
    });
  });

  it("never touches other providers' entries — oauth, api_key, or otherwise", async () => {
    writeFileSync(
      authPath,
      JSON.stringify(
        {
          "github-copilot": { type: "oauth", refresh: "ghu_x", access: "y", expires: 123 },
          anthropic: { type: "api_key", key: "sk-ant-existing" },
        },
        null,
        2,
      ),
    );

    const store = createAuthJsonCredentialStore({ authPath });
    await store.set("crossbar-unsloth-example", "sk-unsloth-abc123");

    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(raw["github-copilot"]).toEqual({ type: "oauth", refresh: "ghu_x", access: "y", expires: 123 });
    expect(raw["anthropic"]).toEqual({ type: "api_key", key: "sk-ant-existing" });
    expect(raw["crossbar-unsloth-example"]).toEqual({ type: "api_key", key: "sk-unsloth-abc123" });
  });

  it("remove() deletes only the targeted id", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    await store.set("crossbar-unsloth-a", "key-a");
    await store.set("crossbar-unsloth-b", "key-b");

    await store.remove("crossbar-unsloth-a");

    expect(await store.get("crossbar-unsloth-a")).toBeUndefined();
    expect(await store.get("crossbar-unsloth-b")).toBe("key-b");
  });

  it("remove() on an unknown id is a no-op, not a throw", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    await store.remove("never-existed");
    // No throw is the assertion; also confirm the file wasn't created for nothing.
    expect(existsSync(authPath)).toBe(false);
  });

  it("get() on a non-api_key entry (e.g. oauth) returns undefined rather than the wrong shape", async () => {
    writeFileSync(
      authPath,
      JSON.stringify({ "github-copilot": { type: "oauth", refresh: "ghu_x" } }, null, 2),
    );
    const store = createAuthJsonCredentialStore({ authPath });
    expect(await store.get("github-copilot")).toBeUndefined();
  });

  it("treats a corrupt auth.json as empty rather than throwing, and recovers on the next write", async () => {
    writeFileSync(authPath, "not valid json{{{");
    const store = createAuthJsonCredentialStore({ authPath });

    expect(await store.get("crossbar-unsloth-example")).toBeUndefined();
    await store.set("crossbar-unsloth-example", "sk-unsloth-abc123");
    expect(await store.get("crossbar-unsloth-example")).toBe("sk-unsloth-abc123");
  });

  it("writes auth.json with 0600 permissions", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    await store.set("crossbar-unsloth-example", "sk-unsloth-abc123");

    const mode = statSync(authPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("leaves no stray temp files behind after a write", async () => {
    const store = createAuthJsonCredentialStore({ authPath });
    await store.set("crossbar-unsloth-example", "sk-unsloth-abc123");

    const leftover = readdirSync(dir).filter((f) => f !== "auth.json");
    expect(leftover).toEqual([]);
    expect(existsSync(authPath)).toBe(true);
  });
});
