/**
 * Crossbar onboarding overlay — the `/crossbar` in-TUI setup flow.
 *
 * Exports:
 *  - Pure, unit-testable helpers:
 *      buildDiscoveredItems   — SelectItem[] from discovered servers + existing registry
 *      buildModelItems        — SelectItem[] from ModelDescriptor[]
 *      capabilityActions      — capability-filtered action list
 *      normalizeManualUrl     — coerce bare host:port / missing-scheme inputs to a valid origin
 *
 *  - The flow driver:
 *      openOnboarding         — ctx.ui.custom overlay: discover → pick → (manual add) → test → model → save
 *
 * HARD RULES (mirrored from ARCHITECTURE.md):
 *  - Never log or serialize the API key the user enters.
 *  - No raw ANSI — all styling through theme.fg(token, ...).
 *  - No new dependencies; only the injected Probe (via createProbe) for connection tests.
 *  - Do NOT modify src/core/, src/adapters/, src/registry/, or any other frozen modules.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";

import type { BackendAdapter } from "../core/backend-adapter.ts";
import { canIntrospect, canLoadUnload, canSwitch } from "../core/backend-adapter.ts";
import type { DiscoveredServer, LoadedState, ModelDescriptor, ServerRecord } from "../core/types.ts";
import type { ServerRegistry } from "../registry/registry.ts";
import { serverId } from "../registry/ids.ts";
import { adapterFor } from "../adapters/index.ts";
import { unregisterServer } from "../shim/provider-shim.ts";
import { createProbe } from "../discovery/probe.ts";

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Extract a `host:port` string from a base URL for compact labels. */
function hostPortOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "");
  }
}

/** Capitalise a backend kind for display, e.g. "lmstudio" → "Lmstudio". */
function kindLabelOf(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Build a `SelectItem[]` representing the servers shown in the top-level onboarding
 * list.  Three kinds of entry can appear:
 *   - discovered servers (in discovery order) — already-registered ones get an
 *     "(added)" suffix so the user can tell new from known;
 *   - registered servers that are NOT currently discovered (e.g. offline), so they
 *     can still be managed/removed;
 *   - a sentinel "Add manually" entry, always last.
 *
 * Selecting any already-registered entry opens the manage overlay; selecting a new
 * discovered entry or the sentinel runs the add flow.
 */
export function buildDiscoveredItems(
  discovered: DiscoveredServer[],
  existing: ServerRecord[],
): SelectItem[] {
  const existingIds = new Set(existing.map((r) => r.id));
  const discoveredUrls = new Set(discovered.map((s) => s.baseUrl));

  const items: SelectItem[] = discovered.map((server): SelectItem => {
    const id = serverId(server.kind, server.baseUrl);
    const isAdded = existingIds.has(id);

    // Compose a label: "[kind] host:port  ✓ healthy" or "(added)"
    const healthMark = isAdded ? "(added)" : "✓ healthy";
    const label = `${kindLabelOf(server.kind)} (${hostPortOf(server.baseUrl)})`;

    return {
      value: server.baseUrl,
      label: isAdded ? `${label}  (added)` : label,
      description: isAdded
        ? `Already registered · ${healthMark}`
        : `${healthMark} · auth: ${server.auth}${server.version ? ` · v${server.version}` : ""}`,
    };
  });

  // Append registered servers that weren't discovered this scan (offline / not
  // reachable right now) so they remain manageable from the same list.
  for (const record of existing) {
    if (!record.enabled) continue;
    if (discoveredUrls.has(record.baseUrl)) continue;
    items.push({
      value: record.baseUrl,
      label: `${kindLabelOf(record.kind)} (${hostPortOf(record.baseUrl)})  (added)`,
      description: "Registered · not currently discovered",
    });
  }

  // Always append the manual-add sentinel
  items.push({
    value: "__manual__",
    label: "＋ Add server…",
    description: "Enter a URL manually",
  });

  return items;
}

/**
 * Build a `SelectItem[]` from a list of ModelDescriptors for the model-picker
 * step of the onboarding flow.
 *
 * The description line surfaces the context window (when known) and any
 * capability badges (vision, tools, reasoning, embeddings).
 */
export function buildModelItems(models: ModelDescriptor[]): SelectItem[] {
  return models.map((m): SelectItem => {
    const parts: string[] = [];

    if (m.contextWindow !== undefined) {
      const ctx =
        m.contextWindow >= 1000
          ? `${Math.round(m.contextWindow / 1000)}k ctx`
          : `${m.contextWindow} ctx`;
      parts.push(ctx);
    }

    const caps: string[] = [];
    if (m.reasoning) caps.push("reasoning");
    if (m.tools) caps.push("tools");
    if (m.input.includes("image")) caps.push("vision");
    if (m.embeddings) caps.push("embeddings");
    if (caps.length > 0) parts.push(caps.join(" · "));

    const item: SelectItem = {
      value: m.id,
      label: m.name || m.id,
    };
    if (parts.length > 0) {
      item.description = parts.join("  ");
    }
    return item;
  });
}

/**
 * Return only the actions that `adapter` actually supports — capability-driven
 * hiding in its simplest form.
 *
 *  - "switch"    requires SwitchModel   (present on Ollama, LM Studio, llama-swap)
 *  - "load"      requires LoadUnload    (present on Ollama, LM Studio)
 *  - "unload"    requires LoadUnload
 *  - "introspect" requires IntrospectLoaded (present on Ollama, LM Studio)
 *
 * vLLM, OpenAI, Anthropic, and the generic adapter all lack these, so the
 * returned list will be empty (or reduced) for them.
 */
export function capabilityActions(
  adapter: BackendAdapter,
): { label: string; value: string }[] {
  const actions: { label: string; value: string }[] = [];

  if (canSwitch(adapter)) {
    actions.push({ label: "Switch model", value: "switch" });
  }
  if (canLoadUnload(adapter)) {
    actions.push({ label: "Load model", value: "load" });
    actions.push({ label: "Unload model", value: "unload" });
  }
  if (canIntrospect(adapter)) {
    actions.push({ label: "Inspect loaded models", value: "introspect" });
  }

  return actions;
}

/** One-line hints shown under each manage action. */
const ACTION_DESCRIPTIONS: Record<string, string> = {
  switch: "Make a model the active/served one",
  load: "Load a model into memory",
  unload: "Evict a loaded model from memory",
  introspect: "Show which models are currently loaded",
  remove: "Forget this server and delete its stored key",
};

/**
 * Build the manage-overlay action list for an already-registered server: the
 * adapter's capability-filtered actions (switch / load / unload / introspect) plus
 * a "Remove server" action that is always available. Backends without any local
 * capabilities (vLLM, OpenAI, Anthropic, generic) show only "Remove server".
 */
export function buildManageItems(adapter: BackendAdapter): SelectItem[] {
  const items: SelectItem[] = capabilityActions(adapter).map((a) => {
    const item: SelectItem = { value: a.value, label: a.label };
    const desc = ACTION_DESCRIPTIONS[a.value];
    if (desc !== undefined) item.description = desc;
    return item;
  });
  items.push({
    value: "remove",
    label: "Remove server",
    description: ACTION_DESCRIPTIONS["remove"]!,
  });
  return items;
}

/**
 * Coerce a user-supplied string (which may be bare "host:port", missing a scheme,
 * or already a valid URL) into a well-formed origin with no trailing slash.
 *
 * Rules applied in order:
 *   1. Trim whitespace.
 *   2. If input already starts with "http://" or "https://", parse as-is.
 *   3. If it looks like "host:port" (no "://"), prefix "http://".
 *   4. Strip any path/query/fragment — we want only the origin.
 *   5. Strip trailing slashes.
 *
 * Returns the coerced origin string.  Throws if the result is not a valid URL.
 */
export function normalizeManualUrl(input: string): string {
  let raw = input.trim();

  // Already has a scheme → use as-is for parsing
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `http://${raw}`;
  }

  const u = new URL(raw); // throws DOMException / TypeError on invalid input
  // Return only the origin (scheme + host + port), no path
  return u.origin.replace(/\/+$/, "");
}

// ─── Shared overlay + server-action helpers ─────────────────────────────────

/** Reconstruct a minimal DiscoveredServer from a persisted record for adapter calls. */
function serverFromRecord(record: ServerRecord): DiscoveredServer {
  return {
    kind: record.kind,
    baseUrl: record.baseUrl,
    auth: record.auth,
    label: record.label,
    confidence: 1,
  };
}

/**
 * Render a single-select overlay (titled SelectList in an accent border) and resolve
 * to the chosen item value, or `null` on Esc/cancel. Shared by the model picker and
 * the manage menus so they stay visually consistent.
 */
function selectOverlay(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  hint: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));

      const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);

      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", hint)));
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) {
            done(null);
            return;
          }
          list.handleInput(data);
          _tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "60%" } },
  );
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Fetch a server's models (live, falling back to last-known on failure). */
async function fetchModels(
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<ModelDescriptor[] | null> {
  const adapter = adapterFor(record.kind);
  const cred = await registry.resolveCredential(record);
  const probe = createProbe(record.baseUrl, { auth: cred, defaultTimeoutMs: 5000 });
  try {
    return await adapter.listModels(serverFromRecord(record), cred, probe);
  } catch (err) {
    if (record.lastKnownModels && record.lastKnownModels.length > 0) {
      return record.lastKnownModels;
    }
    ctx.ui.notify(`Crossbar: could not list models — ${errMsg(err)}`, "error");
    return null;
  }
}

/** Switch the active model or load a model: pick from the list, then call the adapter. */
async function performModelAction(
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
  action: "switch" | "load",
): Promise<void> {
  const adapter = adapterFor(record.kind);
  const models = await fetchModels(ctx, registry, record);
  if (!models) return;
  if (models.length === 0) {
    ctx.ui.notify("Crossbar: server returned no models.", "warning");
    return;
  }

  const title = action === "switch"
    ? `Switch model — ${record.label}`
    : `Load model — ${record.label}`;
  const modelId = await selectOverlay(
    ctx,
    title,
    buildModelItems(models.filter((m) => !m.embeddings)),
    "↑↓ navigate · Enter select · Esc cancel",
  );
  if (!modelId) return;

  const cred = await registry.resolveCredential(record);
  // Loads can be slow (cold model into VRAM) — give them a generous budget.
  const probe = createProbe(record.baseUrl, { auth: cred, defaultTimeoutMs: 60_000 });

  ctx.ui.notify(
    `Crossbar: ${action === "switch" ? "switching to" : "loading"} ${modelId}…`,
    "info",
  );
  try {
    if (action === "switch") {
      if (!canSwitch(adapter)) return;
      await adapter.switchModel(serverFromRecord(record), cred, modelId, probe);
    } else {
      if (!canLoadUnload(adapter)) return;
      await adapter.loadUnload(serverFromRecord(record), cred, modelId, "load", probe);
    }
    ctx.ui.notify(
      `Crossbar: ${modelId} ${action === "switch" ? "is now active" : "loaded"}.`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Crossbar: ${action} failed — ${errMsg(err)}`, "error");
  }
}

/** Unload a currently-loaded model: resolve the loaded set, pick one, evict it. */
async function performUnload(
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<void> {
  const adapter = adapterFor(record.kind);
  if (!canLoadUnload(adapter)) return;
  const cred = await registry.resolveCredential(record);
  const probe = createProbe(record.baseUrl, { auth: cred, defaultTimeoutMs: 5000 });

  let loadedIds: string[] = record.lastKnownLoaded ?? [];
  if (canIntrospect(adapter)) {
    try {
      const state = await adapter.introspectLoaded(serverFromRecord(record), cred, probe);
      loadedIds = state.loadedModelIds;
    } catch {
      // Fall back to last-known on a failed introspection.
    }
  }
  if (loadedIds.length === 0) {
    ctx.ui.notify("Crossbar: no models are currently loaded.", "info");
    return;
  }

  const modelId = await selectOverlay(
    ctx,
    `Unload model — ${record.label}`,
    loadedIds.map((id) => ({ value: id, label: id })),
    "↑↓ navigate · Enter select · Esc cancel",
  );
  if (!modelId) return;

  ctx.ui.notify(`Crossbar: unloading ${modelId}…`, "info");
  try {
    await adapter.loadUnload(serverFromRecord(record), cred, modelId, "unload", probe);
    ctx.ui.notify(`Crossbar: ${modelId} unloaded.`, "info");
  } catch (err) {
    ctx.ui.notify(`Crossbar: unload failed — ${errMsg(err)}`, "error");
  }
}

/** Read and report the currently-loaded models for a server. */
async function performIntrospect(
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<void> {
  const adapter = adapterFor(record.kind);
  if (!canIntrospect(adapter)) return;
  const cred = await registry.resolveCredential(record);
  const probe = createProbe(record.baseUrl, { auth: cred, defaultTimeoutMs: 5000 });

  let state: LoadedState;
  try {
    state = await adapter.introspectLoaded(serverFromRecord(record), cred, probe);
  } catch (err) {
    ctx.ui.notify(`Crossbar: could not read loaded models — ${errMsg(err)}`, "error");
    return;
  }
  if (state.loadedModelIds.length === 0) {
    ctx.ui.notify(`Crossbar: ${record.label} has no models loaded.`, "info");
    return;
  }
  const summary = state.loadedModelIds
    .map((id) => {
      const ctxLen = state.perModel?.[id]?.contextLength;
      if (ctxLen === undefined) return id;
      const ctxStr = ctxLen >= 1000 ? `${Math.round(ctxLen / 1000)}k` : `${ctxLen}`;
      return `${id} (${ctxStr} ctx)`;
    })
    .join(", ");
  ctx.ui.notify(`Crossbar: ${record.label} loaded — ${summary}`, "info");
}

/** Confirm and remove a server from the registry, auth.json, and Pi. */
async function performRemove(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<void> {
  const confirm = await ctx.ui.select(`Remove ${record.label}?`, ["Cancel", "Remove server"]);
  if (confirm !== "Remove server") return;
  unregisterServer(pi, record);
  await registry.remove(record.id);
  ctx.ui.notify(`Crossbar: removed ${record.label}.`, "info");
}

/**
 * Open the manage overlay for an already-registered server: show the
 * capability-filtered action menu and dispatch the chosen action.
 */
export async function openServerActions(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: OnboardingDeps,
  record: ServerRecord,
): Promise<void> {
  const { registry } = deps;
  const adapter = adapterFor(record.kind);

  const choice = await selectOverlay(
    ctx,
    `Manage — ${record.label}`,
    buildManageItems(adapter),
    "↑↓ navigate · Enter select · Esc close",
  );
  if (!choice) return;

  switch (choice) {
    case "switch":
      await performModelAction(ctx, registry, record, "switch");
      break;
    case "load":
      await performModelAction(ctx, registry, record, "load");
      break;
    case "unload":
      await performUnload(ctx, registry, record);
      break;
    case "introspect":
      await performIntrospect(ctx, registry, record);
      break;
    case "remove":
      await performRemove(pi, ctx, registry, record);
      break;
  }
}

// ─── Overlay flow driver ────────────────────────────────────────────────────

export interface OnboardingDeps {
  registry: ServerRegistry;
  discover: () => Promise<DiscoveredServer[]>;
}

/**
 * Open the Crossbar onboarding overlay.
 *
 * Flow:
 *  1. Run discovery and show discovered servers + "Add manually" entry.
 *  2a. If user picks a discovered server → test connection (health + listModels).
 *  2b. If user picks "Add manually" → prompt for URL, optional API key, test.
 *  3. Pick a default model from the server's model list.
 *  4. Save to registry (+ auth.json for api keys).
 *
 * The driver is intentionally thin: item building is delegated to the pure helpers
 * above, and connection testing goes through the same `createProbe` + adapter
 * `health`/`listModels` pair that production and the conformance tests use.
 *
 * @param pi  - ExtensionAPI (needed to honour the ExtensionCommandContext signature for commands)
 * @param ctx - ExtensionCommandContext from the `/crossbar` command handler
 * @param deps - injected registry + discover function (for testability)
 */
export async function openOnboarding(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: OnboardingDeps,
): Promise<void> {
  const { registry, discover } = deps;

  // ── Step 0: run discovery (non-blocking for the overlay; we show a spinner) ──
  ctx.ui.notify("Crossbar: scanning localhost for backends…", "info");

  let discovered: DiscoveredServer[] = [];
  try {
    discovered = await discover();
  } catch {
    // Discovery failures are non-fatal — the user can still add manually
  }

  const existing = registry.list();

  // ── Step 1: show top-level discovery list ──────────────────────────────────
  const topItems = buildDiscoveredItems(discovered, existing);

  const chosenBaseUrl = await ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const container = new Container();

      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Crossbar — Local Model Servers"))),
      );
      container.addChild(
        new Text(theme.fg("muted", "Select a discovered server or add one manually.")),
      );

      const list = new SelectList(
        topItems,
        Math.min(topItems.length, 12),
        getSelectListTheme(),
      );

      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);

      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel")),
      );
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          _tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "60%" } },
  );

  if (!chosenBaseUrl) return; // user cancelled

  // ── Step 2: manual add branch ──────────────────────────────────────────────
  let targetBaseUrl: string;
  let manualApiKey: string | undefined;
  let discoveredServer: DiscoveredServer | undefined;

  if (chosenBaseUrl === "__manual__") {
    // 2a. Ask for URL
    const rawUrl = await ctx.ui.input("Server URL", "e.g. localhost:11434 or http://192.168.1.5:8080");
    if (!rawUrl) return;

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeManualUrl(rawUrl);
    } catch {
      ctx.ui.notify("Crossbar: invalid URL — could not parse.", "error");
      return;
    }

    // 2b. Ask for API key (with no-auth option)
    const authChoice = await ctx.ui.select(
      "Authentication",
      ["No authentication (open server)", "Enter API key"],
    );
    if (authChoice === undefined) return;

    if (authChoice === "Enter API key") {
      const key = await ctx.ui.input("API key", "Paste your key (hidden after this dialog)");
      if (key === undefined) return;
      // key may be empty string if user submitted blank — treat as no-auth
      manualApiKey = key.length > 0 ? key : undefined;
    }

    targetBaseUrl = normalizedUrl;
  } else {
    // Already-registered server (discovered or offline) → open the manage overlay
    // instead of re-running the add flow.
    const existingRecord = registry.list().find((r) => r.baseUrl === chosenBaseUrl);
    if (existingRecord) {
      await openServerActions(pi, ctx, deps, existingRecord);
      return;
    }

    // New discovered server path
    discoveredServer = discovered.find((s) => s.baseUrl === chosenBaseUrl);
    targetBaseUrl = chosenBaseUrl;
  }

  // ── Step 3: fingerprint (if we don't already have a DiscoveredServer) ─────
  if (!discoveredServer) {
    ctx.ui.notify("Crossbar: testing connection…", "info");

    const cred =
      manualApiKey !== undefined
        ? { mode: "apiKey" as const, apiKey: manualApiKey }
        : { mode: "none" as const };

    const probe = createProbe(targetBaseUrl, { auth: cred, defaultTimeoutMs: 3000 });

    // Try each non-cloud adapter in probe order; first match wins
    const { DISCOVERY_ADAPTERS } = await import("../adapters/index.ts");
    for (const adapter of DISCOVERY_ADAPTERS) {
      try {
        const result = await adapter.fingerprint(targetBaseUrl, probe);
        if (result) {
          discoveredServer = result;
          // Propagate auth mode from the user's input
          if (manualApiKey !== undefined) {
            discoveredServer = { ...result, auth: "apiKey" };
          }
          break;
        }
      } catch {
        // fingerprint failures are non-fatal
      }
    }

    if (!discoveredServer) {
      ctx.ui.notify(
        "Crossbar: could not identify the server — check the URL and try again.",
        "error",
      );
      return;
    }
  }

  // ── Step 4: list models ────────────────────────────────────────────────────
  ctx.ui.notify(`Crossbar: connected to ${discoveredServer.label} — fetching models…`, "info");

  const adapter = adapterFor(discoveredServer.kind);
  const cred =
    manualApiKey !== undefined
      ? { mode: "apiKey" as const, apiKey: manualApiKey }
      : { mode: "none" as const };

  const probe = createProbe(targetBaseUrl, { auth: cred, defaultTimeoutMs: 5000 });

  let models: ModelDescriptor[] = [];
  try {
    models = await adapter.listModels(discoveredServer, cred, probe);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Crossbar: could not list models — ${msg}`, "error");
    return;
  }

  if (models.length === 0) {
    ctx.ui.notify("Crossbar: server is reachable but returned no models.", "warning");
    return;
  }

  // ── Step 5: pick default model ─────────────────────────────────────────────
  const chosenModelId = await selectOverlay(
    ctx,
    `Pick default model — ${discoveredServer.label}`,
    buildModelItems(models),
    "↑↓ navigate · Enter select · Esc skip",
  );

  // chosenModelId === null means the user skipped — still register the server

  // ── Step 6: save to registry ───────────────────────────────────────────────
  const id = serverId(discoveredServer.kind, targetBaseUrl);
  const record: ServerRecord = {
    id,
    kind: discoveredServer.kind,
    baseUrl: targetBaseUrl,
    label: discoveredServer.label,
    auth: discoveredServer.auth,
    enabled: true,
    addedAt: Date.now(),
    ...(chosenModelId !== null ? { lastKnownModels: models } : {}),
  };

  // Pass the api key separately so it goes through the registry → authStorage path
  // (never written into crossbar.json)
  await registry.add(record, manualApiKey);

  const modelNote =
    chosenModelId !== null ? ` Default model: ${chosenModelId}.` : "";
  ctx.ui.notify(
    `Crossbar: ${discoveredServer.label} added!${modelNote} It will appear in /model.`,
    "info",
  );
}
