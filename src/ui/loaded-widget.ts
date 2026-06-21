/**
 * Live "currently loaded" model widget for Crossbar.
 *
 * Two public surfaces:
 *
 *  1. PURE, UNIT-TESTABLE functions:
 *     - `formatLoadedStatus` — renders the status string from pre-computed entries.
 *     - `computeLoadedEntries` — fetches live loaded state from each enabled server,
 *       falling back to lastKnownLoaded when introspection is unavailable.
 *
 *  2. `installLoadedWidget` — wires everything to Pi's `ctx.ui.setStatus`, subscribes
 *     to `model_select`, and exposes a `refresh()` the health-poll loop calls.
 *
 * Hard rules:
 *  - Never modify src/core/, src/adapters/, src/registry/.
 *  - Only the injected Probe (createProbe) is used for network calls.
 *  - API keys are NEVER logged.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { adapterFor } from "../adapters/index.ts";
import { canIntrospect } from "../core/backend-adapter.ts";
import { createProbe } from "../discovery/probe.ts";
import type { ServerRegistry } from "../registry/registry.ts";
import type { LoadedState } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry per enabled server, ready for formatting. */
export interface LoadedEntry {
  /** Human label for the server, e.g. "Ollama". */
  label: string;
  /** Currently-loaded model ids (may be empty). */
  loaded: string[];
  /** Whether the data came from a live introspection call or a cache. */
  source: LoadedState["source"];
}

// ---------------------------------------------------------------------------
// Pure formatter — no I/O, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Render a compact status string from pre-computed loaded entries.
 *
 * Examples:
 *   live:      "● Ollama:llama3.1"
 *   last-known "◷ vLLM:qwen (last-known)"
 *   empty set  "no servers"
 *   multi      "● Ollama:llama3.1  ◷ vLLM:qwen (last-known)"
 *
 * Uses only `theme.fg(token, text)` with tokens: accent/success/dim/muted/warning.
 */
export function formatLoadedStatus(
  entries: LoadedEntry[],
  theme: Pick<Theme, "fg">,
): string {
  if (entries.length === 0) {
    return theme.fg("muted", "no servers");
  }

  const parts: string[] = [];

  for (const entry of entries) {
    const isLive = entry.source === "introspection";

    if (entry.loaded.length === 0) {
      // Server known but no model loaded
      const marker = isLive
        ? theme.fg("dim", "○")
        : theme.fg("warning", "◷");
      const label = theme.fg("dim", `${entry.label}:idle`);
      const suffix = isLive ? "" : theme.fg("dim", " (last-known)");
      parts.push(`${marker} ${label}${suffix}`);
    } else {
      for (const modelId of entry.loaded) {
        const marker = isLive
          ? theme.fg("accent", "●")
          : theme.fg("warning", "◷");
        const text = isLive
          ? theme.fg("success", `${entry.label}:${modelId}`)
          : theme.fg("muted", `${entry.label}:${modelId}`);
        const suffix = isLive ? "" : theme.fg("dim", " (last-known)");
        parts.push(`${marker} ${text}${suffix}`);
      }
    }
  }

  return parts.join("  ");
}

// ---------------------------------------------------------------------------
// Entry computation — one network round-trip per server that supports introspection
// ---------------------------------------------------------------------------

/**
 * For each enabled server in the registry:
 *   - If its adapter supports `IntrospectLoaded`, call `introspectLoaded` via a fresh
 *     Probe → source "introspection".
 *   - Otherwise fall back to `record.lastKnownLoaded` → source "last-known".
 *   - Per-server failures degrade that entry to "last-known" (never throw the whole batch).
 */
export async function computeLoadedEntries(
  registry: ServerRegistry,
): Promise<LoadedEntry[]> {
  const records = registry.list().filter((r) => r.enabled);
  const results = await Promise.allSettled(
    records.map(async (record): Promise<LoadedEntry> => {
      const adapter = adapterFor(record.kind);

      if (canIntrospect(adapter)) {
        // Resolve credential for the probe
        const cred = await registry.resolveCredential(record);

        // Build a minimal DiscoveredServer from the stored record
        const server = {
          kind: record.kind,
          baseUrl: record.baseUrl,
          auth: record.auth,
          label: record.label,
          confidence: 1,
        } as const;

        const probe = createProbe(record.baseUrl, { auth: cred });

        const state = await adapter.introspectLoaded(server, cred, probe);
        return {
          label: record.label,
          loaded: state.loadedModelIds,
          source: "introspection" as const,
        };
      }

      // Fall back to last-known
      return {
        label: record.label,
        loaded: record.lastKnownLoaded ?? [],
        source: "last-known" as const,
      };
    }),
  );

  const entries: LoadedEntry[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result === undefined) continue;
    if (result.status === "fulfilled") {
      entries.push(result.value);
    } else {
      // Per-server failure: degrade to last-known without throwing
      const record = records[i];
      if (record !== undefined) {
        entries.push({
          label: record.label,
          loaded: record.lastKnownLoaded ?? [],
          source: "last-known" as const,
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Widget installer — thin Pi-API wiring
// ---------------------------------------------------------------------------

/** The status key used with `ctx.ui.setStatus`. */
const STATUS_KEY = "crossbar-loaded";

export interface LoadedWidgetHandle {
  /** Called by the health-poll loop to push a fresh snapshot to the status bar. */
  refresh(): Promise<void>;
  /** Clean up the event subscription. */
  dispose(): void;
}

/**
 * Wire the loaded-model widget to Pi's status bar.
 *
 * - Reads `ctx.ui.theme` each refresh so theme switches take effect immediately.
 * - Listens to `model_select` to refresh on user-driven model changes.
 * - Returns `{ refresh, dispose }` for the health-poll loop to drive.
 */
export function installLoadedWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registry: ServerRegistry,
): LoadedWidgetHandle {
  async function refresh(): Promise<void> {
    try {
      const entries = await computeLoadedEntries(registry);
      const text = formatLoadedStatus(entries, ctx.ui.theme);
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // Silently suppress: the widget is best-effort; never crash the poll loop.
    }
  }

  // Refresh on every model-select event (user switched model via /model or Ctrl+P).
  // pi.on() returns void — there is no per-listener unsubscribe in the Pi extension API.
  pi.on("model_select", () => {
    void refresh();
  });

  // Initial render
  void refresh();

  return {
    refresh,
    dispose(): void {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    },
  };
}
