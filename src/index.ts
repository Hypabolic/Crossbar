/**
 * @hypabolic/crossbar — Pi extension entry point.
 *
 * Wires the frozen core + Wave A/B/C modules into Pi's lifecycle:
 *   session_start  → load crossbar.json, register saved servers, auto-discover localhost,
 *                    install the loaded-model widget, start the health poll.
 *   /crossbar      → open the discovery / onboarding overlay (alias /local).
 *   session_shutdown → stop the poll, dispose the widget.
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
      // Persist only when the catalogue changed in a registration-relevant way.
      if (catalogueChanged(record.lastKnownModels, liveModels)) {
        await reg.setLastKnownModels(record.id, liveModels);
      }
      // Always update lastSeenAt ephemerally (no persist).
      reg.updateHealthCache(record.id, { lastSeenAt: Date.now() });
      models = liveModels;
    } catch {
      // Offline / unreachable — fall back to last-known models (may be empty).
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

    // 3) Loaded-model widget + health poll (UI modes only — a long-lived timer must
    //    not keep one-shot/headless CLI runs alive). Each tick refreshes health +
    //    models (re-registering on change) for every enabled server, then repaints.
    if (ctx.hasUI) {
      widget = installLoadedWidget(pi, ctx, reg);
      const tick = async (): Promise<void> => {
        await pollAll(pi, reg);
        await widget?.refresh();
      };
      await tick();
      pollTimer = setInterval(() => {
        void tick();
      }, HEALTH_POLL_MS);
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
    await openOnboarding(pi, ctx, {
      registry,
      discover: async () => {
        lastDiscovered = await discover();
        return lastDiscovered;
      },
      initialDiscovered: lastDiscovered,
      sessionHidden,
    });
    await widget?.refresh();
  };

  pi.registerCommand("crossbar", {
    description: "Manage local & self-hosted model backends — discover, add, switch (Crossbar)",
    handler: openCmd,
  });
  pi.registerCommand("local", {
    description: "Alias for /crossbar",
    handler: openCmd,
  });
}
