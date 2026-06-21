/**
 * Adapter registry — the canonical set of backend adapters Crossbar ships with, plus lookup helpers
 * the discovery engine, registry, and provider shim consume.
 *
 * The generic OpenAI-compatible adapter is the fallback for the long tail (TabbyAPI, KoboldCpp,
 * oobabooga, Jan, llamafile, and unknown servers) — those kinds have no dedicated adapter and resolve
 * to `genericAdapter` via fingerprint.
 */

import type { BackendAdapter } from "../core/backend-adapter.ts";
import type { BackendKind } from "../core/capability.ts";
import { CLOUD_KINDS } from "../core/capability.ts";

import { ollamaAdapter } from "./ollama.ts";
import { lmstudioAdapter } from "./lmstudio.ts";
import { llamacppAdapter } from "./llamacpp.ts";
import { llamaswapAdapter } from "./llamaswap.ts";
import { vllmAdapter } from "./vllm.ts";
import { openaiAdapter } from "./openai.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { genericAdapter } from "./generic.ts";

/** Every adapter Crossbar ships. */
export const ADAPTERS: readonly BackendAdapter[] = [
  ollamaAdapter,
  lmstudioAdapter,
  llamacppAdapter,
  llamaswapAdapter,
  vllmAdapter,
  openaiAdapter,
  anthropicAdapter,
  genericAdapter,
];

/** Lookup by kind. Note: only kinds with a dedicated adapter are present; the tail maps to generic. */
export const ADAPTERS_BY_KIND: Partial<Record<BackendKind, BackendAdapter>> = Object.fromEntries(
  ADAPTERS.map((a) => [a.kind, a]),
) as Partial<Record<BackendKind, BackendAdapter>>;

/** Resolve an adapter for a kind, falling back to the generic OpenAI-compat adapter. */
export function adapterFor(kind: BackendKind): BackendAdapter {
  return ADAPTERS_BY_KIND[kind] ?? genericAdapter;
}

/** Adapters used for active discovery (cloud kinds are configured, never probed). */
export const DISCOVERY_ADAPTERS: readonly BackendAdapter[] = ADAPTERS.filter(
  (a) => !CLOUD_KINDS.has(a.kind),
);

/** Cloud adapters (configured via onboarding / `/login`, not port-probed). */
export const CLOUD_ADAPTERS: readonly BackendAdapter[] = ADAPTERS.filter((a) =>
  CLOUD_KINDS.has(a.kind),
);

export {
  ollamaAdapter,
  lmstudioAdapter,
  llamacppAdapter,
  llamaswapAdapter,
  vllmAdapter,
  openaiAdapter,
  anthropicAdapter,
  genericAdapter,
};
