/**
 * Crossbar config persistence — crossbar.json (non-secret) and the CredentialStore boundary.
 *
 * crossbar.json lives at getAgentDir()/crossbar.json and contains only non-secret server metadata.
 * API keys are stored separately via the CredentialStore (backed by Pi's authStorage at runtime).
 *
 * The `dir` override in opts lets tests pass a temp directory instead of touching ~/.pi.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CrossbarConfigFile, ServerRecord } from "../core/types.ts";

export { tmpdir }; // re-export for tests

/**
 * Interface that Pi's authStorage will be adapted to at runtime.
 * Kept as a plain interface here so the persistence module never imports Pi runtime.
 */
export interface CredentialStore {
  get(id: string): string | undefined | Promise<string | undefined>;
  set(id: string, key: string): void | Promise<void>;
  remove(id: string): void | Promise<void>;
}

export interface PersistenceOpts {
  /** Override the directory for crossbar.json (default: getAgentDir()). Used in tests. */
  dir?: string;
}

function resolveDir(opts?: PersistenceOpts): string {
  return opts?.dir ?? getAgentDir();
}

function configPath(opts?: PersistenceOpts): string {
  return join(resolveDir(opts), "crossbar.json");
}

/**
 * Strip any `apiKey` field that may have leaked into a ServerRecord.
 * This is a safety guard: crossbar.json must never contain secrets.
 */
function stripSecrets(record: ServerRecord): ServerRecord {
  const { ...safe } = record as ServerRecord & { apiKey?: unknown };
  // biome-ignore lint: intentional runtime secret guard
  delete (safe as Record<string, unknown>)["apiKey"];
  return safe;
}

/**
 * Validate that a parsed value looks like a CrossbarConfigFile.
 * Returns the canonical form, or null if the value is invalid.
 */
function parseConfigFile(raw: unknown): CrossbarConfigFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) return null;
  if (!Array.isArray(obj["servers"])) return null;
  const result: CrossbarConfigFile = {
    version: 1,
    servers: (obj["servers"] as unknown[]).filter(
      (s): s is ServerRecord => typeof s === "object" && s !== null,
    ),
  };
  const rawSettings = obj["settings"];
  if (typeof rawSettings === "object" && rawSettings !== null) {
    result.settings = rawSettings as NonNullable<CrossbarConfigFile["settings"]>;
  }
  return result;
}

const EMPTY_CONFIG: CrossbarConfigFile = { version: 1, servers: [] };

/**
 * Load crossbar.json from the agent dir (or the override dir in tests).
 * Returns a default empty config if the file is missing or invalid.
 */
export async function loadConfig(opts?: PersistenceOpts): Promise<CrossbarConfigFile> {
  const path = configPath(opts);
  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as unknown;
    const config = parseConfigFile(parsed);
    return config ?? { ...EMPTY_CONFIG };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/**
 * Atomically write crossbar.json (temp file + rename).
 * Strips any apiKey fields that may have crept into ServerRecords.
 */
export async function saveConfig(config: CrossbarConfigFile, opts?: PersistenceOpts): Promise<void> {
  const dir = resolveDir(opts);
  mkdirSync(dir, { recursive: true });

  const safe: CrossbarConfigFile = {
    ...config,
    servers: config.servers.map(stripSecrets),
  };

  const json = JSON.stringify(safe, null, 2);
  const dest = configPath(opts);
  // Write to a sibling temp file in the same dir so rename is atomic (same filesystem)
  const tmp = join(dir, `.crossbar-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, json, { encoding: "utf-8" });
  renameSync(tmp, dest);
}
