/**
 * @hypabolic/crossbar — Pi extension entry point.
 *
 * Wires the frozen core + Wave A/B/C modules into Pi's lifecycle:
 *   session_start  → load crossbar.json, register saved servers, auto-discover localhost,
 *                    install the loaded-model widget and paint it once.
 *   /crossbar      → open the discovery / onboarding overlay (alias /local); the health/
 *                    loaded poll runs only for the duration of this overlay.
 *   session_shutdown → stop any running poll, dispose the widget.
 *
 * Secrets live only in Pi's auth.json (via the CredentialStore bridge); crossbar.json holds metadata.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { DiscoveredServer, ModelDescriptor, ServerRecord } from "./core/index.ts";
import { adapterFor, DISCOVERY_ADAPTERS } from "./adapters/index.ts";
import { discoverLan, discoverLocalhost } from "./discovery/engine.ts";
import { expandHosts, localSubnetCidrs } from "./discovery/subnet.ts";
import { createProbe } from "./discovery/probe.ts";
import { catalogueChanged, pollAll } from "./poll.ts";
import { preloadCachedProviders } from "./preload.ts";
import { loadConfig, saveConfig } from "./registry/persistence.ts";
import { createPiCredentialStore } from "./registry/pi-credential-store.ts";
import { serverId } from "./registry/ids.ts";
import { ServerRegistry } from "./registry/registry.ts";
import { registerServer, unregisterServer } from "./shim/provider-shim.ts";
import { openOnboarding } from "./ui/onboarding.ts";
import { installLoadedWidget, type LoadedWidgetHandle } from "./ui/loaded-widget.ts";

const HEALTH_POLL_MS = 15_000;

/** Status-bar key for the transient "scanning…" indicator shown during startup discovery. */
const SCAN_STATUS_KEY = "crossbar-scan";

/** Minimal DiscoveredServer reconstructed from a persisted record for adapter calls. */
function recordToServer(record: ServerRecord): DiscoveredServer {
  return {
    kind: record.kind,
    baseUrl: record.baseUrl,
    auth: record.auth,
    label: record.label,
    confidence: 1,
  };
}

export default async function crossbar(pi: ExtensionAPI): Promise<void> {
  // Phase 1: register saved providers before Pi resolves model scopes.
  await preloadCachedProviders(pi);

  let registry: ServerRegistry | undefined;
  let widget: LoadedWidgetHandle | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  /** Cache of the most recent discovery (populated at startup with localhost-only;
   *  refreshed on every /crossbar Rescan which does the full sweep when LAN on).
   *  Passed as initialDiscovered so opening /crossbar does not re-scan. */
  let lastDiscovered: DiscoveredServer[] = [];
  // Servers "hidden for this session" — lives for the whole Pi session (until reload),
  // so a hide survives closing and reopening /crossbar. Permanent dismissals are persisted.
  const sessionHidden = new Set<string>();

  // The health/loaded poll runs ONLY while /crossbar is open — during normal coding
  // Crossbar never touches the backend. Each tick probes health + the loaded-model
  // widget; the model catalogue is NOT re-listed here (that happens on startup, rescan,
  // and manage actions only). Idempotent start/stop so reopening can't stack timers.
  const startPoll = (): void => {
    if (pollTimer || !registry) return;
    const reg = registry;
    const tick = async (): Promise<void> => {
      await pollAll(reg);
      await widget?.refresh();
    };
    void tick();
    pollTimer = setInterval(() => void tick(), HEALTH_POLL_MS);
  };
  const stopPoll = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  // Discovery honours CrossbarSettings: custom probe ports always, plus opt-in LAN
  // probing. When LAN discovery is on and no explicit hosts are given, sweep the
  // machine's own private subnet(s); explicit hosts/CIDRs override that. Reads
  // settings from the registry at call time so settings-overlay edits apply next scan.
  //
  // `includeLan` defaults true (the /crossbar path). Startup passes false so the slow
  // LAN sweep never blocks first paint — LAN servers are surfaced in /crossbar instead.
  const discover = async (opts?: { includeLan?: boolean }): Promise<DiscoveredServer[]> => {
    const adapters = [...DISCOVERY_ADAPTERS];
    const settings = registry?.getSettings();
    const ports =
      settings?.probePorts && settings.probePorts.length > 0 ? settings.probePorts : undefined;

    // Hide servers the user has dismissed (e.g. a reachable Ollama with only
    // embedding models) from every consumer — both /crossbar and auto-register.
    const reg = registry;
    const keep = (list: DiscoveredServer[]): DiscoveredServer[] =>
      reg ? list.filter((s) => !reg.isDismissed(s.baseUrl)) : list;

    const local = await discoverLocalhost(adapters, ports ? { ports } : undefined);
    if (opts?.includeLan === false || !settings?.lanDiscovery) {
      return keep(local);
    }

    // Explicit hosts/CIDRs win; otherwise auto-scan the local subnet(s).
    const specs =
      settings.lanHosts && settings.lanHosts.length > 0 ? settings.lanHosts : localSubnetCidrs();
    const { hosts } = expandHosts(specs);
    if (hosts.length === 0) {
      return keep(local); // LAN on but nothing to probe (no hosts and no detectable subnet)
    }

    // A subnet sweep is hundreds of origins — probe many at once with a short
    // per-probe timeout (LAN RTT is tiny). `livenessFirst` makes each dead address
    // cost a single socket, so the high concurrency stays within fd limits and the
    // whole /24 finishes in a few seconds.
    const lan = await discoverLan(adapters, hosts, {
      ...(ports ? { ports } : {}),
      concurrency: 128,
      timeoutMs: 400,
      livenessFirst: true,
    });
    const seen = new Set(local.map((s) => s.baseUrl));
    return keep([...local, ...lan.filter((s) => !seen.has(s.baseUrl))]);
  };

  /** Best-effort: refresh a server's model list and (re)register it with Pi. Returns models used. */
  async function refreshAndRegister(reg: ServerRegistry, record: ServerRecord): Promise<number> {
    const adapter = adapterFor(record.kind);
    const cred = await reg.resolveCredential(record);
    let models: ModelDescriptor[] = record.lastKnownModels ?? [];
    try {
      const probe = createProbe(record.baseUrl, { auth: cred });
      const liveModels = await adapter.listModels(recordToServer(record), cred, probe);
      // Apply context overrides (persisted per-server, take precedence over discovered values).
      const overrides = reg.getContextOverrides(record.id);
      const modelsWithOverrides = reg.applyContextOverrides(liveModels, overrides);
      // Persist only when the catalogue changed in a registration-relevant way.
      if (catalogueChanged(record.lastKnownModels, modelsWithOverrides)) {
        await reg.setLastKnownModels(record.id, modelsWithOverrides);
      }
      // Always update lastSeenAt ephemerally (no persist).
      reg.updateHealthCache(record.id, { lastSeenAt: Date.now() });
      models = modelsWithOverrides;
    } catch {
      // Offline / unreachable — fall back to last-known models (may be empty).
      // Apply overrides to cached models too.
      const overrides = reg.getContextOverrides(record.id);
      models = reg.applyContextOverrides(models, overrides);
    }
    const chatModelCount = models.filter((model) => !model.embeddings).length;
    if (chatModelCount === 0) return 0; // nothing registrable (server offline, no cache)
    await registerServer(pi, reg, record, models);
    return chatModelCount;
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Rebuild cleanly on every start/reload.
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }

    const store = createPiCredentialStore(ctx.modelRegistry.authStorage);
    const reg = new ServerRegistry({ store, persist: (cfg) => saveConfig(cfg) });
    const cfg = await loadConfig();
    reg.load(cfg); // registry now owns discovery settings (cfg.settings)
    registry = reg;

    // Visible "scanning" status so the brief startup probe never looks like a stall.
    // Separate status key from the loaded-model widget; cleared in `finally`.
    if (ctx.hasUI) {
      ctx.ui.setStatus(SCAN_STATUS_KEY, ctx.ui.theme.fg("accent", "⟳ Crossbar: scanning for model servers…"));
    }

    try {
      // 1) Register every enabled server from the saved config.
      for (const record of reg.list()) {
        if (!record.enabled) continue;
        try {
          await refreshAndRegister(reg, record);
        } catch {
          // Never let one bad server abort startup.
        }
      }

      // 2) Auto-discover LOCALHOST ONLY (the LAN sweep is deferred to /crossbar so it
      //    never blocks first paint). Localhost no-auth servers auto-register unless
      //    turned off; keyed servers are surfaced for the user to add via /crossbar.
      try {
        const found = await discover({ includeLan: false });
        lastDiscovered = found;
        const autoRegister = reg.getSettings()?.autoRegisterLocalhost !== false; // default on
        for (const srv of found) {
          const id = serverId(srv.kind, srv.baseUrl);
          if (reg.get(id)) continue; // already known
          if (srv.auth !== "none" || !autoRegister) {
            if (ctx.hasUI) {
              const reason = srv.auth !== "none" ? "needs an API key" : "auto-register is off";
              ctx.ui.notify(`Crossbar: found ${srv.label} (${reason}) — run /crossbar to add it.`, "info");
            }
            continue;
          }
          const record: ServerRecord = {
            id,
            kind: srv.kind,
            baseUrl: srv.baseUrl,
            label: srv.label,
            auth: "none",
            enabled: true,
            addedAt: Date.now(),
            lastSeenAt: Date.now(),
          };
          await reg.add(record);
          const count = await refreshAndRegister(reg, record);
          if (ctx.hasUI && count > 0) {
            ctx.ui.notify(`Crossbar: registered ${srv.label} (${count} models).`, "info");
          }
        }
      } catch {
        // Discovery is best-effort; the user can always add servers via /crossbar.
      }
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(SCAN_STATUS_KEY, undefined);
    }

    // 3) Loaded-model widget (UI modes only). Paint the current loaded state once at
    //    startup, but do NOT start a recurring timer here — the periodic poll runs only
    //    while /crossbar is open (see openCmd), so a backgrounded session is silent.
    if (ctx.hasUI) {
      widget = installLoadedWidget(pi, ctx, reg);
      await widget.refresh();
    }
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    // Unwind our Pi provider registrations so a reload starts clean.
    // Replacement runtimes (reload/new/resume/fork) execute the async factory
    // again (via resourceLoader.reload + fresh ExtensionRunner), which calls
    // preloadCachedProviders from the on-disk cache BEFORE the replacement
    // session_start. Preload registrations are flushed into ModelRegistry on
    // bindCore (wrapped try/catch per Pi). Shutdown unregs + factory re-preloads
    // by stable id therefore leaves the replacement with its cached providers.
    // (No cross-runtime gap in final state; transient unreg window is inherent
    // to reload and only affects in-process interactive queries.)
    if (registry) {
      for (const record of registry.list()) {
        try {
          unregisterServer(pi, record);
        } catch {
          // Best-effort cleanup; never block shutdown.
        }
      }
    }
    widget?.dispose();
    widget = undefined;
  });

  const openCmd = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!registry) {
      ctx.ui.notify("Crossbar is still initialising — try again in a moment.", "warning");
      return;
    }
    // Health/loaded polling is live only for the duration of this management session.
    startPoll();
    try {
      await openOnboarding(pi, ctx, {
        registry,
        discover: async () => {
          lastDiscovered = await discover();
          return lastDiscovered;
        },
        initialDiscovered: lastDiscovered,
        sessionHidden,
      });
    } finally {
      stopPoll();
      await widget?.refresh();
    }
  };

  pi.registerCommand("crossbar", {
    description: "Manage local & self-hosted model backends — discover, add, switch (Crossbar)",
    handler: openCmd,
  });
  pi.registerCommand("local", {
    description: "Alias for /crossbar",
    handler: openCmd,
  });

  /**
   * Set or clear a per-model context window override for a Crossbar server.
   * Usage: /crossbar-set-context-length <server-id> <model-id> <tokens|auto>
   *   tokens: positive integer (e.g. 32768)
   *   auto: clear the override, use auto-detected value
   */
  const setContextLengthCmd = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!registry) {
      ctx.ui.notify("Crossbar is still initialising — try again in a moment.", "warning");
      return;
    }

    const parts = args.trim().split(/\s+/);
    if (parts.length < 3) {
      ctx.ui.notify(
        "Usage: /crossbar-set-context-length <server-id> <model-id> <tokens|auto>\n" +
        "  tokens: positive integer (e.g. 32768)\n" +
        "  auto: clear the override, use auto-detected value",
        "error",
      );
      return;
    }

    const serverIdStr = parts[0];
    const modelId = parts[1];
    const ctxSizeStr = parts[2];

    if (!serverIdStr || !modelId || !ctxSizeStr) {
      ctx.ui.notify("Invalid arguments. Usage: /crossbar-set-context-length <server-id> <model-id> <tokens|auto>", "error");
      return;
    }

    // Find the server record by id or label
    const record = registry.list().find(
      (r) => r.id === serverIdStr || r.label === serverIdStr,
    );
    if (!record) {
      ctx.ui.notify(
        `Server "${serverIdStr}" not found. Run /crossbar to see available servers.`,
        "error",
      );
      return;
    }

    if (ctxSizeStr === "auto") {
      const ok = await ctx.ui.confirm(
        "Clear context override",
        `Use auto-detected context window for "${modelId}" on ${record.label}?`,
      );
      if (!ok) return;

      await registry.setContextOverride(record.id, modelId, undefined);
      ctx.ui.notify(
        `Context override removed for "${modelId}" on ${record.label}. Now auto-detected.`,
        "info",
      );
      return;
    }

    const ctxSize = Number(ctxSizeStr);
    if (!Number.isInteger(ctxSize) || ctxSize < 1) {
      ctx.ui.notify(
        `Invalid context size: "${ctxSizeStr}". Use a positive integer or "auto".\n` +
        "Example: /crossbar-set-context-length llama-swap-8080 my-model 32768",
        "error",
      );
      return;
    }

    const ok = await ctx.ui.confirm(
      "Set context override",
      `Set context window to ${ctxSize} for "${modelId}" on ${record.label}?`,
    );
    if (!ok) return;

    await registry.setContextOverride(record.id, modelId, ctxSize);
    ctx.ui.notify(
      `Context window for "${modelId}" on ${record.label} set to ${ctxSize}.`,
      "info",
    );
  };

  pi.registerCommand("crossbar-set-context-length", {
    description: "Set or clear per-model context window override for a Crossbar server",
    handler: setContextLengthCmd,
  });
}
