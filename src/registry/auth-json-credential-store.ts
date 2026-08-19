/**
 * Direct auth.json–backed CredentialStore.
 *
 * Background: pi-coding-agent 0.80+ removed the extension-facing `AuthStorage`
 * class from its public SDK surface (see CHANGELOG "Replaced the SDK's
 * `CreateAgentSessionOptions.authStorage` and `modelRegistry` options with the
 * async `modelRuntime` option. `AuthStorage` and its storage backends are no
 * longer exported"). `ExtensionContext.modelRegistry` no longer exposes
 * `authStorage` at all, so `createPiCredentialStore()` (which read
 * `ctx.modelRegistry.authStorage`) crashes with "Cannot read properties of
 * undefined (reading 'set')" the moment Crossbar tries to persist a key.
 *
 * Only `readStoredCredential()` (one-off, read-only) is still exported by the
 * SDK. There is currently no supported write path for extensions.
 *
 * This module restores Crossbar's original guarantee — "secrets live only in
 * Pi's auth.json, never crossbar.json" — by reading/writing that file directly,
 * in the exact flat-map shape Pi itself uses:
 *
 *   { "<providerId>": { "type": "api_key", "key": "<...>" }, ... }
 *
 * Writes are read-modify-write + atomic rename (temp file on the same
 * filesystem), so a concurrent Pi-side write (e.g. an OAuth login finishing
 * around the same time) can only ever lose one side's *own* key entry in the
 * unlikely event both writes race — never corrupt the file. Every entry
 * belonging to other providers (anthropic, openrouter, github-copilot, ...)
 * is preserved verbatim; Crossbar only ever touches its own provider ids.
 *
 * File mode is forced to 0600, matching Pi's own auth.json permissions.
 *
 * # Why built-in providers (anthropic, openai, github-copilot, ...) still "just work"
 *
 * This might look contradictory at first: Crossbar needed this whole module because
 * `AuthStorage` was removed, yet `/login` for Anthropic/OpenAI/GitHub Copilot and typing an
 * API key for one of them still transparently reads and writes `auth.json` with no issue.
 * The resolution is that pi-coding-agent 0.80.8 removed `AuthStorage` from the EXTENSION-FACING
 * SDK surface only — not from pi-coding-agent itself. Built-in providers are driven by Pi's
 * internal `ModelRuntime` (`setRuntimeApiKey()`, `login()`, etc. — see
 * `dist/core/model-runtime.d.ts`), which keeps full, privileged, in-process access to the same
 * `auth.json`. The CHANGELOG line is precise about the scope:
 *
 *   "AuthStorage and its storage backends are no longer exported"
 *
 * — exported meaning exported *to extensions*, not removed from the core. What actually
 * disappeared is only the bridge extensions used to reach in from outside
 * (`CreateAgentSessionOptions.authStorage`, `ExtensionContext.modelRegistry.authStorage`).
 *
 * Crossbar doesn't register its backends (Unsloth Studio, llama.cpp, vLLM, ...) as built-in
 * providers — it registers them through the EXTENSION provider API, `pi.registerProvider(id,
 * config)`, which is exactly the API that lost its privileged path into `auth.json` when
 * `AuthStorage` stopped being exported. This module doesn't bypass any security boundary Pi
 * introduced; it replicates, for Crossbar's own provider ids, the same read/write/0600
 * behaviour Pi's internal `ModelRuntime` already performs for its built-in providers — and,
 * per the read-modify-write contract above, never touches an id it doesn't own.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "./persistence.ts";

interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

/** Other credential shapes (oauth, etc.) are opaque to us — preserved as-is. */
type AuthJsonEntry = ApiKeyCredential | Record<string, unknown>;
type AuthJsonData = Record<string, AuthJsonEntry>;

export interface AuthJsonStoreOpts {
  /** Override the auth.json path (tests only). Default: getAgentDir()/auth.json. */
  authPath?: string;
}

function resolvePath(opts?: AuthJsonStoreOpts): string {
  return opts?.authPath ?? join(getAgentDir(), "auth.json");
}

function readAll(path: string): AuthJsonData {
  try {
    if (!existsSync(path)) return {};
    const text = readFileSync(path, "utf-8");
    if (text.trim().length === 0) return {};
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AuthJsonData;
    }
    return {};
  } catch {
    // Missing, unreadable, or corrupt — treat as empty rather than throwing.
    // A subsequent write will recreate the file; other providers' credentials
    // may already be unrecoverable at that point, but we never make it worse.
    return {};
  }
}

function writeAll(path: string, data: AuthJsonData): void {
  const json = JSON.stringify(data, null, 2);
  const tmp = `${path}.crossbar-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, json, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort — some filesystems (e.g. certain network mounts) reject chmod.
  }
}

function isApiKeyCredential(entry: AuthJsonEntry | undefined): entry is ApiKeyCredential {
  return !!entry && (entry as Record<string, unknown>)["type"] === "api_key" && typeof (entry as Record<string, unknown>)["key"] === "string";
}

/**
 * Build a {@link CredentialStore} that reads/writes auth.json directly.
 * Every operation re-reads the file first so concurrent external changes
 * (Pi logging a provider in/out in the same process) are never clobbered
 * for keys other than the one being touched.
 */
export function createAuthJsonCredentialStore(opts?: AuthJsonStoreOpts): CredentialStore {
  const path = resolvePath(opts);

  return {
    get(id: string): string | undefined {
      const data = readAll(path);
      const entry = data[id];
      return isApiKeyCredential(entry) ? entry.key : undefined;
    },
    set(id: string, key: string): void {
      const data = readAll(path);
      data[id] = { type: "api_key", key };
      writeAll(path, data);
    },
    remove(id: string): void {
      const data = readAll(path);
      if (id in data) {
        delete data[id];
        writeAll(path, data);
      }
    },
  };
}
