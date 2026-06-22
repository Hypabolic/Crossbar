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
import type { CrossbarSettings, DiscoveredServer, LoadedState, ModelDescriptor, ServerRecord } from "../core/types.ts";
import type { ServerRegistry } from "../registry/registry.ts";
import { serverId } from "../registry/ids.ts";
import { adapterFor } from "../adapters/index.ts";
import { registerServer, unregisterServer } from "../shim/provider-shim.ts";
import { createProbe } from "../discovery/probe.ts";
import { expandHosts, localSubnetCidrs } from "../discovery/subnet.ts";
import { catalogueChanged } from "../poll.ts";

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

const KIND_LABELS: Partial<Record<ServerRecord["kind"], string>> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  llamaswap: "llama-swap",
  vllm: "vLLM",
  openai: "OpenAI",
  anthropic: "Anthropic",
  tabbyapi: "TabbyAPI",
  koboldcpp: "KoboldCpp",
  oobabooga: "oobabooga",
  jan: "Jan",
  llamafile: "llamafile",
  "openai-generic": "OpenAI-compatible",
};

/** Human-readable backend name for compact selector labels. */
function kindLabelOf(kind: string): string {
  return KIND_LABELS[kind as ServerRecord["kind"]] ?? kind;
}

/**
 * Build a `SelectItem[]` representing the servers shown in the top-level onboarding
 * list.  Three kinds of entry can appear:
 *   - discovered servers (in discovery order) — already-registered ones get an
 *     "(added)" suffix so the user can tell new from known;
 *   - registered servers that are NOT currently discovered (e.g. offline), so they
 *     can still be managed/removed;
 *   - rescan and manual-add actions, always last.
 *
 * Selecting any already-registered entry opens the manage overlay; selecting a new
 * discovered entry or the sentinel runs the add flow.
 */
export function buildDiscoveredItems(
  discovered: DiscoveredServer[],
  existing: ServerRecord[],
): SelectItem[] {
  const existingById = new Map(existing.map((record) => [record.id, record]));
  const discoveredUrls = new Set(discovered.map((s) => s.baseUrl));

  const items: SelectItem[] = discovered.map((server): SelectItem => {
    const id = serverId(server.kind, server.baseUrl);
    const saved = existingById.get(id);
    const isAdded = saved !== undefined;

    const label = `${kindLabelOf(server.kind)} (${hostPortOf(server.baseUrl)})`;

    return {
      value: server.baseUrl,
      label: saved
        ? `${label}  (${saved.enabled ? "added" : "disabled"})`
        : label,
      description: isAdded
        ? saved.enabled
          ? "Already registered · ✓ healthy"
          : "Saved but disabled · server is reachable"
        : `✓ healthy · auth: ${server.auth}${server.version ? ` · v${server.version}` : ""}`,
    };
  });

  // Append registered servers that weren't discovered this scan (offline,
  // disabled, or not reachable right now) so they remain manageable.
  for (const record of existing) {
    if (discoveredUrls.has(record.baseUrl)) continue;
    items.push({
      value: record.baseUrl,
      label: `${kindLabelOf(record.kind)} (${hostPortOf(record.baseUrl)})  (${record.enabled ? "added" : "disabled"})`,
      description: record.enabled
        ? "Registered · not currently discovered"
        : "Saved but disabled · select to manage",
    });
  }

  // Utility actions stay at the bottom of the selector.
  items.push({
    value: "__rescan__",
    label: "⟳ Rescan for servers",
    description: "Refresh the discovered server list",
  });
  items.push({
    value: "__settings__",
    label: "⚙ Discovery settings…",
    description: "LAN discovery, hosts, and probe ports",
  });
  items.push({
    value: "__manual__",
    label: "＋ Add server…",
    description: "Enter a URL manually",
  });

  return items;
}

// ─── Discovery-settings helpers ─────────────────────────────────────────────

/**
 * Parse a user-entered port list ("11434, 8080 1234") into a sorted, de-duplicated
 * array of valid TCP ports (1–65535). Invalid tokens are dropped; an empty/whitespace
 * input yields `[]` (meaning "use the per-backend defaults").
 */
export function parsePorts(input: string): number[] {
  const ports: number[] = [];
  for (const token of input.split(/[\s,]+/)) {
    if (token.length === 0) continue;
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.push(n);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

/**
 * Parse a user-entered host list ("192.168.1.50, nas.local") into a trimmed,
 * de-duplicated array. Empty input yields `[]`.
 */
export function parseHosts(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h.length > 0))];
}

/**
 * Drop default/empty fields so crossbar.json stays clean: LAN off and empty
 * host/port lists are simply absent.
 */
function cleanSettings(settings: CrossbarSettings): CrossbarSettings {
  const out: CrossbarSettings = {};
  if (settings.lanDiscovery) out.lanDiscovery = true;
  if (settings.lanHosts && settings.lanHosts.length > 0) out.lanHosts = settings.lanHosts;
  if (settings.probePorts && settings.probePorts.length > 0) out.probePorts = settings.probePorts;
  return out;
}

/** Build the discovery-settings menu, reflecting the current values in each label. */
export function buildSettingsItems(settings: CrossbarSettings): SelectItem[] {
  const lanOn = settings.lanDiscovery === true;
  const hosts = settings.lanHosts ?? [];
  const ports = settings.probePorts ?? [];
  return [
    {
      value: "toggle-lan",
      label: `LAN discovery: ${lanOn ? "ON" : "OFF"}`,
      description: lanOn ? "Scanning the LAN for backends" : "Localhost only (default)",
    },
    {
      value: "edit-hosts",
      label: `LAN hosts: ${hosts.length > 0 ? hosts.join(", ") : "auto (local subnet)"}`,
      description: "Blank scans your local subnet · accepts IPs, hostnames, or CIDR (10.0.1.0/24)",
    },
    {
      value: "edit-ports",
      label: `Probe ports: ${ports.length > 0 ? ports.join(", ") : "defaults"}`,
      description: "Ports scanned on each host (blank = per-backend defaults)",
    },
    { value: "back", label: "← Back to servers", description: "Return to the server list" },
  ];
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
    actions.push({ label: "Switch active model", value: "switch" });
  }
  if (canLoadUnload(adapter)) {
    actions.push({ label: "Load model", value: "load" });
    actions.push({ label: "Unload model", value: "unload" });
  }
  if (canIntrospect(adapter)) {
    actions.push({ label: "View loaded models", value: "introspect" });
  }

  return actions;
}

/** One-line hints shown under each manage action. */
const ACTION_DESCRIPTIONS: Record<string, string> = {
  switch: "Activate it on the server and select it in Pi",
  load: "Load a model into memory",
  unload: "Evict a loaded model from memory",
  introspect: "Open a live loaded-model snapshot",
  enable: "Register its models with Pi again",
  disable: "Stop registering its models (keeps the server saved)",
  remove: "Forget this server and delete its stored key",
  back: "Return to the server list",
};

/**
 * Build the manage-overlay action list for an already-registered server: the
 * adapter's capability-filtered actions (switch / load / unload / introspect),
 * an enable/disable toggle (driven by `enabled`), and a "Remove server" action.
 * Backends without any local capabilities (vLLM, OpenAI, Anthropic, generic) show
 * only the enable/disable toggle and "Remove server".
 */
export function buildManageItems(adapter: BackendAdapter, enabled: boolean): SelectItem[] {
  const items: SelectItem[] = (enabled ? capabilityActions(adapter) : []).map((a) => {
    const item: SelectItem = { value: a.value, label: a.label };
    const desc = ACTION_DESCRIPTIONS[a.value];
    if (desc !== undefined) item.description = desc;
    return item;
  });
  items.push(
    enabled
      ? { value: "disable", label: "Disable server", description: ACTION_DESCRIPTIONS["disable"]! }
      : { value: "enable", label: "Enable server", description: ACTION_DESCRIPTIONS["enable"]! },
  );
  items.push({
    value: "remove",
    label: "Remove server",
    description: ACTION_DESCRIPTIONS["remove"]!,
  });
  items.push({
    value: "back",
    label: "← Back to servers",
    description: ACTION_DESCRIPTIONS["back"]!,
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

/** Render a read-only detail overlay. Enter or Esc returns to the previous menu. */
function detailOverlay(
  ctx: ExtensionCommandContext,
  title: string,
  lines: string[],
): Promise<void> {
  return ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));
      container.addChild(new Text(""));
      for (const line of lines) {
        container.addChild(new Text(line));
      }
      container.addChild(new Text(""));
      container.addChild(new Text(theme.fg("dim", "Enter / Esc  back")));
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape") || matchesKey(data, "return")) {
            done();
          }
        },
      };
    },
    { overlay: true, overlayOptions: { width: "70%" } },
  );
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function chatModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return models.filter((model) => !model.embeddings);
}

/** Select a registered Crossbar model as Pi's current model. */
async function selectPiModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  record: ServerRecord,
  modelId: string,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(record.id, modelId);
  if (!model) {
    ctx.ui.notify(
      `Crossbar: ${modelId} is not registered in Pi yet.`,
      "warning",
    );
    return false;
  }
  const selected = await pi.setModel(model);
  if (!selected) {
    ctx.ui.notify(`Crossbar: Pi could not select ${modelId}.`, "error");
  }
  return selected;
}

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
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
  action: "switch" | "load",
): Promise<void> {
  const adapter = adapterFor(record.kind);
  const models = await fetchModels(ctx, registry, record);
  if (!models) return;
  const selectableModels = chatModels(models);
  if (selectableModels.length === 0) {
    ctx.ui.notify("Crossbar: server returned no chat models.", "warning");
    return;
  }

  const title = action === "switch"
    ? `Switch model — ${record.label}`
    : `Load model — ${record.label}`;
  const modelId = await selectOverlay(
    ctx,
    title,
    buildModelItems(selectableModels),
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
    if (action === "switch") {
      const selected = await selectPiModel(pi, ctx, record, modelId);
      ctx.ui.notify(
        selected
          ? `Crossbar: ${modelId} is active on the server and selected in Pi.`
          : `Crossbar: ${modelId} is active on the server; select it from /model.`,
        selected ? "info" : "warning",
      );
    } else {
      ctx.ui.notify(`Crossbar: ${modelId} loaded.`, "info");
    }
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

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 ** 3);
  return gib >= 0.1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB` : `${Math.round(bytes / (1024 ** 2))} MiB`;
}

/** Read and present the currently-loaded models for a server. */
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
    await detailOverlay(
      ctx,
      `Loaded models — ${record.label}`,
      ["No models are currently loaded."],
    );
    return;
  }
  const lines = state.loadedModelIds.flatMap((id, index) => {
    const info = state.perModel?.[id];
    const details: string[] = [];
    if (info?.contextLength !== undefined) {
      const ctxStr = info.contextLength >= 1000
        ? `${Math.round(info.contextLength / 1000)}k`
        : `${info.contextLength}`;
      details.push(`${ctxStr} context`);
    }
    if (info?.vramBytes !== undefined) details.push(`${formatBytes(info.vramBytes)} VRAM`);
    if (info?.expiresAt !== undefined) {
      const remainingMs = info.expiresAt - Date.now();
      details.push(remainingMs > 0 ? `unloads in ${Math.ceil(remainingMs / 60_000)} min` : "unload pending");
    }
    return [
      `${index + 1}. ${id}`,
      ...(details.length > 0 ? [`   ${details.join(" · ")}`] : []),
    ];
  });
  await detailOverlay(ctx, `Loaded models — ${record.label}`, lines);
}

/**
 * Toggle a server's enabled state. Disabling unregisters its Pi provider (its
 * models leave `/model`) but keeps the saved record; enabling re-registers it.
 */
async function performToggleEnabled(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<void> {
  const next = !record.enabled;
  await registry.setEnabled(record.id, next);
  if (!next) {
    unregisterServer(pi, record);
    ctx.ui.notify(
      `Crossbar: ${record.label} disabled — removed from /model. If it was active, select another model with /model.`,
      "info",
    );
    return;
  }
  const models = await fetchModels(ctx, registry, record);
  const selectableModels = models ? chatModels(models) : [];
  if (models && selectableModels.length > 0) {
    try {
      // Persist the refreshed catalogue (persist-before-register) so the next
      // process preloads the current model list rather than a stale cache.
      if (catalogueChanged(record.lastKnownModels, models)) {
        await registry.setLastKnownModels(record.id, models);
      }
      await registerServer(pi, registry, record, models);
      ctx.ui.notify(
        `Crossbar: ${record.label} enabled — ${selectableModels.length} models in /model.`,
        "info",
      );
    } catch (err) {
      await registry.setEnabled(record.id, false);
      ctx.ui.notify(`Crossbar: could not enable ${record.label} — ${errMsg(err)}`, "error");
    }
  } else {
    await registry.setEnabled(record.id, false);
    ctx.ui.notify(
      `Crossbar: could not enable ${record.label} — no chat models are reachable.`,
      "warning",
    );
  }
}

/** Confirm and remove a server from the registry, auth.json, and Pi. */
async function performRemove(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
  record: ServerRecord,
): Promise<boolean> {
  const confirm = await ctx.ui.select(`Remove ${record.label}?`, ["Cancel", "Remove server"]);
  if (confirm !== "Remove server") return false;
  unregisterServer(pi, record);
  await registry.remove(record.id);
  ctx.ui.notify(
    `Crossbar: removed ${record.label}. If it was active, select another model with /model.`,
    "info",
  );
  return true;
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
  let current = record;

  while (true) {
    const adapter = adapterFor(current.kind);
    const choice = await selectOverlay(
      ctx,
      `Manage — ${current.label}${current.enabled ? "" : " (disabled)"}`,
      buildManageItems(adapter, current.enabled),
      "↑↓ navigate · Enter select · Esc back",
    );
    if (!choice || choice === "back") return;

    switch (choice) {
      case "switch":
        await performModelAction(pi, ctx, registry, current, "switch");
        break;
      case "load":
        await performModelAction(pi, ctx, registry, current, "load");
        break;
      case "unload":
        await performUnload(ctx, registry, current);
        break;
      case "introspect":
        await performIntrospect(ctx, registry, current);
        break;
      case "enable":
      case "disable":
        await performToggleEnabled(pi, ctx, registry, current);
        break;
      case "remove":
        if (await performRemove(pi, ctx, registry, current)) return;
        break;
    }

    const refreshed = registry.get(current.id);
    if (!refreshed) return;
    current = refreshed;
  }
}

/**
 * Discovery-settings overlay: a persistent menu to toggle LAN discovery and edit
 * the LAN host / probe-port lists. Each change is written through the registry
 * (which persists settings alongside servers), and `discover()` reads them at the
 * next scan. Esc or "Back" returns to the server list.
 */
async function openSettings(
  ctx: ExtensionCommandContext,
  registry: ServerRegistry,
): Promise<void> {
  while (true) {
    const current = registry.getSettings() ?? {};
    const choice = await selectOverlay(
      ctx,
      "Crossbar — Discovery Settings",
      buildSettingsItems(current),
      "↑↓ navigate · Enter select · Esc back",
    );
    if (!choice || choice === "back") return;

    if (choice === "toggle-lan") {
      const next = cleanSettings({ ...current, lanDiscovery: !current.lanDiscovery });
      await registry.setSettings(next);
      if (!next.lanDiscovery) {
        ctx.ui.notify("Crossbar: LAN discovery disabled.", "info");
      } else if (next.lanHosts && next.lanHosts.length > 0) {
        ctx.ui.notify(
          `Crossbar: LAN discovery on — scanning ${next.lanHosts.join(", ")} on the next rescan.`,
          "info",
        );
      } else {
        // Auto mode: scan the machine's own subnet(s).
        const subnets = localSubnetCidrs();
        ctx.ui.notify(
          subnets.length > 0
            ? `Crossbar: LAN discovery on — will scan your local subnet (${subnets.join(", ")}) on the next rescan.`
            : "Crossbar: LAN discovery on, but no local subnet was detected — add hosts or a CIDR below.",
          subnets.length > 0 ? "info" : "warning",
        );
      }
    } else if (choice === "edit-hosts") {
      const raw = await ctx.ui.input(
        "LAN hosts",
        "IPs, hostnames, or CIDR e.g. 10.0.1.0/24 (blank = auto-scan local subnet)",
      );
      if (raw === undefined) continue; // cancelled — leave unchanged
      const next = cleanSettings({ ...current, lanHosts: parseHosts(raw) });
      await registry.setSettings(next);
      const hosts = next.lanHosts ?? [];
      if (hosts.length === 0) {
        ctx.ui.notify("Crossbar: LAN hosts cleared — will auto-scan the local subnet.", "info");
      } else {
        const { hosts: expanded, truncated } = expandHosts(hosts);
        ctx.ui.notify(
          `Crossbar: LAN hosts set — ${hosts.join(", ")} (${expanded.length} addresses).`,
          "info",
        );
        if (truncated) {
          ctx.ui.notify(
            "Crossbar: host list is large; the scan is capped at 1024 addresses.",
            "warning",
          );
        }
      }
    } else if (choice === "edit-ports") {
      const raw = await ctx.ui.input(
        "Probe ports",
        "comma-separated, e.g. 11434, 8080, 1234 (blank = per-backend defaults)",
      );
      if (raw === undefined) continue; // cancelled — leave unchanged
      const ports = parsePorts(raw);
      const next = cleanSettings({ ...current, probePorts: ports });
      await registry.setSettings(next);
      ctx.ui.notify(
        ports.length > 0
          ? `Crossbar: probe ports set — ${ports.join(", ")}.`
          : "Crossbar: probe ports reset to per-backend defaults.",
        "info",
      );
    }
  }
}

// ─── Overlay flow driver ────────────────────────────────────────────────────

export interface OnboardingDeps {
  registry: ServerRegistry;
  discover: () => Promise<DiscoveredServer[]>;
}

function selectServerOverlay(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Crossbar — Local Model Servers"))),
      );
      container.addChild(
        new Text(theme.fg("muted", "Select a server to manage, or add another.")),
      );

      const list = new SelectList(
        items,
        Math.min(items.length, 12),
        getSelectListTheme(),
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);

      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · Enter select · Esc close")),
      );
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

/**
 * Open the Crossbar onboarding overlay.
 *
 * Flow:
 *  1. Run discovery and show discovered + saved servers.
 *  2. Saved server → persistent management menu; Back returns to server list.
 *  3. New/manual server → resolve auth, fingerprint, and list chat models.
 *  4. Optionally select a model to use in Pi now.
 *  5. Save, register immediately, and select the chosen Pi model.
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

  let discovered: DiscoveredServer[] = [];
  const rescan = async (): Promise<void> => {
    ctx.ui.notify("Crossbar: scanning for backends…", "info");
    try {
      discovered = await discover();
    } catch {
      ctx.ui.notify("Crossbar: discovery failed; saved servers are still available.", "warning");
    }
  };
  await rescan();

  while (true) {
    const chosenBaseUrl = await selectServerOverlay(
      ctx,
      buildDiscoveredItems(discovered, registry.list()),
    );

    if (!chosenBaseUrl) return; // Esc at the server list closes Crossbar
    if (chosenBaseUrl === "__rescan__") {
      await rescan();
      continue;
    }
    if (chosenBaseUrl === "__settings__") {
      await openSettings(ctx, registry);
      continue;
    }

    let targetBaseUrl: string;
    let manualApiKey: string | undefined;
    let selectedAuth: "none" | "apiKey" | undefined;
    let discoveredServer: DiscoveredServer | undefined;

    if (chosenBaseUrl === "__manual__") {
      const rawUrl = await ctx.ui.input(
        "Server URL",
        "e.g. localhost:11434 or http://192.168.1.5:8080",
      );
      if (!rawUrl) continue;

      try {
        targetBaseUrl = normalizeManualUrl(rawUrl);
      } catch {
        ctx.ui.notify("Crossbar: invalid URL — could not parse.", "error");
        continue;
      }

      const authChoice = await ctx.ui.select(
        "Authentication",
        ["No authentication (open server)", "Enter API key"],
      );
      if (authChoice === undefined) continue;

      selectedAuth = authChoice === "Enter API key" ? "apiKey" : "none";
      if (selectedAuth === "apiKey") {
        const key = await ctx.ui.input("API key", "Paste your key (hidden after this dialog)");
        if (key === undefined) continue;
        if (key.length === 0) {
          ctx.ui.notify("Crossbar: API key cannot be empty.", "warning");
          continue;
        }
        manualApiKey = key;
      }
    } else {
      const existingRecord = registry.list().find((r) => r.baseUrl === chosenBaseUrl);
      if (existingRecord) {
        await openServerActions(pi, ctx, deps, existingRecord);
        continue;
      }

      discoveredServer = discovered.find((s) => s.baseUrl === chosenBaseUrl);
      if (!discoveredServer) {
        ctx.ui.notify("Crossbar: that server is no longer available.", "warning");
        continue;
      }
      targetBaseUrl = chosenBaseUrl;

      if (discoveredServer.auth === "apiKey") {
        const key = await ctx.ui.input("API key", "Required by this server");
        if (key === undefined) continue;
        if (key.length === 0) {
          ctx.ui.notify("Crossbar: API key cannot be empty.", "warning");
          continue;
        }
        manualApiKey = key;
      }
    }

    // Fingerprint manually entered servers.
    if (!discoveredServer) {
      ctx.ui.notify("Crossbar: testing connection…", "info");
      const cred = manualApiKey !== undefined
        ? { mode: "apiKey" as const, apiKey: manualApiKey }
        : { mode: "none" as const };
      const probe = createProbe(targetBaseUrl, { auth: cred, defaultTimeoutMs: 3000 });

      const { DISCOVERY_ADAPTERS } = await import("../adapters/index.ts");
      for (const adapter of DISCOVERY_ADAPTERS) {
        try {
          const result = await adapter.fingerprint(targetBaseUrl, probe);
          if (result) {
            // The user's explicit auth choice is authoritative. Fingerprinting
            // may use public metadata endpoints even on a keyed server.
            discoveredServer = { ...result, auth: selectedAuth ?? result.auth };
            break;
          }
        } catch {
          // Try the next adapter.
        }
      }

      if (!discoveredServer) {
        ctx.ui.notify(
          "Crossbar: could not identify the server — check the URL and try again.",
          "error",
        );
        continue;
      }
    }

    ctx.ui.notify(
      `Crossbar: connected to ${discoveredServer.label} — fetching models…`,
      "info",
    );

    const adapter = adapterFor(discoveredServer.kind);
    const cred = manualApiKey !== undefined
      ? { mode: "apiKey" as const, apiKey: manualApiKey }
      : { mode: "none" as const };
    const probe = createProbe(targetBaseUrl, { auth: cred, defaultTimeoutMs: 5000 });

    let models: ModelDescriptor[] = [];
    try {
      models = await adapter.listModels(discoveredServer, cred, probe);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Crossbar: could not list models — ${msg}`, "error");
      continue;
    }

    const selectableModels = chatModels(models);
    if (selectableModels.length === 0) {
      ctx.ui.notify("Crossbar: server returned no chat models.", "warning");
      continue;
    }

    const chosenModelId = await selectOverlay(
      ctx,
      `Select model to use in Pi — ${discoveredServer.label}`,
      buildModelItems(selectableModels),
      "↑↓ navigate · Enter select · Esc skip",
    );

    const id = serverId(discoveredServer.kind, targetBaseUrl);
    const record: ServerRecord = {
      id,
      kind: discoveredServer.kind,
      baseUrl: targetBaseUrl,
      label: discoveredServer.label,
      auth: discoveredServer.auth,
      enabled: true,
      addedAt: Date.now(),
      lastKnownModels: models,
    };

    // The key goes to Pi's authStorage, never crossbar.json.
    await registry.add(record, manualApiKey);
    await registerServer(pi, registry, record, models);

    let modelNote = "";
    if (chosenModelId !== null) {
      const selected = await selectPiModel(pi, ctx, record, chosenModelId);
      modelNote = selected
        ? ` Using ${chosenModelId} in Pi.`
        : ` Select ${chosenModelId} from /model.`;
    }
    ctx.ui.notify(
      `Crossbar: ${discoveredServer.label} added and registered (${selectableModels.length} models).${modelNote}`,
      "info",
    );
  }
}
