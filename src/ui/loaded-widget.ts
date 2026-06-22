/**
 * Live "currently loaded" model widget for Crossbar.
 *
 * Shows ONLY the model Pi currently has active (if it comes from a Crossbar server).
 * Nothing is shown when the active model is not from Crossbar (cloud, none, or other provider).
 *
 * Pure functions:
 *  - `formatActiveModel`
 *  - `computeActiveEntry`
 *
 * `installLoadedWidget` wires to Pi setStatus, on model_select + health poll.
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
import type { HealthState } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Pure formatter — no I/O, fully unit-testable
// ---------------------------------------------------------------------------

export interface ActiveEntry {
  /** Server label (from record.label). */
  label: string;
  /** The active model's id (from ctx.model.id). */
  modelId: string;
  /** True if the model was reported present in the latest loaded snapshot. */
  loaded: boolean;
  /** "introspection" if derived from live adapter call this refresh; else "last-known". */
  source: "introspection" | "last-known";
  /** Latest polled health (if any). Unhealthy states change the rendering. */
  health?: HealthState;
}

/**
 * Render status for the single active Crossbar model (or "" to clear).
 *
 * - null/empty → ""
 * - unhealthy (unreachable|degraded|unauthorized) → "✕ label:auth|unreachable|degraded"
 * - else → "● label:modelId" (or "○" if not loaded) + optional " (last-known)"
 *
 * Uses ONLY theme.fg(token, str) with: accent / success / dim / muted / warning.
 */
export function formatActiveModel(
  entry: ActiveEntry | null,
  theme: Pick<Theme, "fg">,
): string {
  if (!entry) return "";

  if (
    entry.health === "unreachable" ||
    entry.health === "degraded" ||
    entry.health === "unauthorized"
  ) {
    const detail = entry.health === "unauthorized" ? "auth" : entry.health;
    return `${theme.fg("warning", "✕")} ${theme.fg("dim", `${entry.label}: ${detail}`)}`;
  }

  const marker = entry.loaded
    ? theme.fg("accent", "●")
    : theme.fg("dim", "○");
  const text = theme.fg("success", `${entry.label}: ${entry.modelId}`);
  const suffix =
    entry.source === "last-known" ? theme.fg("dim", " (last-known)") : "";
  return `${marker} ${text}${suffix}`;
}

// ---------------------------------------------------------------------------
// Active entry computation — introspect ONLY the active server's provider
// (≤1 network call per refresh). Never throws.
// ---------------------------------------------------------------------------

/**
 * Compute the ActiveEntry for Pi's currently selected model (if any).
 *
 * - If no active, or active.provider not in registry → null (widget clears).
 * - If the record supports introspection (and is enabled): do a live call for *that*
 *   server only; on success updateHealthCache({loaded}) and derive `loaded` bool.
 * - On failure or non-introspectable adapter: use record.lastKnownLoaded for the bool.
 * - Health is always taken from the latest poll cache (if present).
 */
export async function computeActiveEntry(
  registry: ServerRegistry,
  active: { provider: string; id: string } | undefined,
): Promise<ActiveEntry | null> {
  if (!active) return null;

  const record = registry.get(active.provider);
  if (!record) return null;

  const health = registry.getHealth(record.id);

  const adapter = adapterFor(record.kind);

  if (record.enabled && canIntrospect(adapter)) {
    try {
      const cred = await registry.resolveCredential(record);

      const server = {
        kind: record.kind,
        baseUrl: record.baseUrl,
        auth: record.auth,
        label: record.label,
        confidence: 1,
      } as const;

      const probe = createProbe(record.baseUrl, { auth: cred });

      const state = await adapter.introspectLoaded(server, cred, probe);
      registry.updateHealthCache(record.id, { loaded: state.loadedModelIds });
      const loaded = state.loadedModelIds.includes(active.id);
      return {
        label: record.label,
        modelId: active.id,
        loaded,
        source: "introspection",
        ...(health !== undefined ? { health } : {}),
      };
    } catch {
      // degrade to last-known for this active model; do not throw
    }
  }

  // last-known path (non-introspect, disabled, or introspect threw)
  const last = record.lastKnownLoaded ?? [];
  const loaded = last.includes(active.id);
  return {
    label: record.label,
    modelId: active.id,
    loaded,
    source: "last-known" as const,
    ...(health !== undefined ? { health } : {}),
  };
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
 * - Only shows status for the *active* ctx.model when its provider is a Crossbar server.
 * - Uses `ctx.model` at refresh time.
 * - Reads `ctx.ui.theme` each refresh.
 * - Listens to `model_select`; also driven by external 15s poll calling refresh().
 * - Returns `{ refresh, dispose }` for the health-poll loop.
 */
export function installLoadedWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registry: ServerRegistry,
): LoadedWidgetHandle {
  async function refresh(): Promise<void> {
    try {
      const active = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      const entry = await computeActiveEntry(registry, active);
      const text = formatActiveModel(entry, ctx.ui.theme);
      ctx.ui.setStatus(STATUS_KEY, text.length > 0 ? text : undefined);
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
