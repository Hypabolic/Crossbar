/**
 * Crossbar core enums — the capability vocabulary every {@link BackendAdapter} declares against.
 *
 * Locked Phase 1 contract. Adapters MUST NOT add new BackendKind / Capability values without an
 * interface revision (bump CONTRACT_VERSION in ./backend-adapter.ts). See ARCHITECTURE.md.
 */

/**
 * The set of capabilities a backend may expose. An adapter declares the subset it supports via
 * {@link BackendAdapter.capabilities}; the UX is driven entirely off this set (hide "switch model"
 * when absent, show last-known instead of live loaded state when introspection is missing, etc.).
 */
export enum Capability {
  /** Can enumerate available models (`/v1/models`, `/api/tags`, ...). Effectively universal. */
  ListModels = "listModels",
  /** Can report which model(s) are currently resident/loaded right now (`/api/ps`, `state`, `/running`). */
  IntrospectLoaded = "introspectLoaded",
  /** Can change the active/served model at runtime (implicit request, JIT load, or proxy swap). */
  SwitchModel = "switchModel",
  /** Can explicitly load and unload a model (`keep_alive:0`, `/load`+`/unload`, `lms`, ...). */
  LoadUnload = "loadUnload",
  /** Exposes a health/liveness signal (`/health`, `GET /` text, ...). */
  Health = "health",
  /** Exposes per-model capability metadata (context window, vision, tools) beyond bare ids. */
  PerModelCaps = "perModelCaps",
  /** Supports streaming responses. Effectively universal for the chat path. */
  Streaming = "streaming",
}

/** Authentication scheme a server requires. Crossbar only ever sends a bearer/api key or nothing. */
export type AuthMode = "none" | "apiKey";

/**
 * Concrete backend identities Crossbar understands. `openai-generic` is the catch-all fallback for
 * anything that merely exposes `/v1/models` (covers the long tail: Jan, llamafile, unknown servers).
 */
export type BackendKind =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "llamaswap"
  | "vllm"
  | "openai"
  | "anthropic"
  | "tabbyapi"
  | "koboldcpp"
  | "oobabooga"
  | "jan"
  | "llamafile"
  | "openai-generic";

/** Backends that are remote cloud services (configured, never port-probed). */
export const CLOUD_KINDS: ReadonlySet<BackendKind> = new Set<BackendKind>(["openai", "anthropic"]);
