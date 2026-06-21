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
import type { DiscoveredServer, ModelDescriptor, ServerRecord } from "../core/types.ts";
import type { ServerRegistry } from "../registry/registry.ts";
import { serverId } from "../registry/ids.ts";
import { adapterFor } from "../adapters/index.ts";
import { createProbe } from "../discovery/probe.ts";

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Build a `SelectItem[]` representing the discovered servers for the top-level
 * onboarding list.  Already-registered servers are marked with a "(added)" suffix
 * so the user can see what is new vs. what Crossbar already knows about.
 *
 * Items are ordered: discovered servers first (in discovery order), then a
 * sentinel "Add manually" entry at the end.
 */
export function buildDiscoveredItems(
  discovered: DiscoveredServer[],
  existing: ServerRecord[],
): SelectItem[] {
  const existingIds = new Set(existing.map((r) => r.id));

  const items: SelectItem[] = discovered.map((server): SelectItem => {
    const id = serverId(server.kind, server.baseUrl);
    const isAdded = existingIds.has(id);

    // Extract host:port from baseUrl for the label suffix
    let hostPort: string;
    try {
      const u = new URL(server.baseUrl);
      hostPort = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    } catch {
      hostPort = server.baseUrl.replace(/^https?:\/\//, "");
    }

    // Compose a label: "[kind] host:port  ✓ healthy" or "(added)"
    const kindLabel = server.kind.charAt(0).toUpperCase() + server.kind.slice(1);
    const healthMark = isAdded ? "(added)" : "✓ healthy";
    const label = `${kindLabel} (${hostPort})`;

    return {
      value: server.baseUrl,
      label: isAdded ? `${label}  (added)` : label,
      description: isAdded
        ? `Already registered · ${healthMark}`
        : `${healthMark} · auth: ${server.auth}${server.version ? ` · v${server.version}` : ""}`,
    };
  });

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
  _pi: ExtensionAPI,
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
    // Discovered server path
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
  const modelItems = buildModelItems(models);

  const chosenModelId = await ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const container = new Container();

      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold(`Pick default model — ${discoveredServer!.label}`))),
      );

      const list = new SelectList(
        modelItems,
        Math.min(modelItems.length, 12),
        getSelectListTheme(),
      );

      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);

      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · Enter select · Esc skip")),
      );
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Allow Esc to skip model selection
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
