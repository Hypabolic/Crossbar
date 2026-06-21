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
import { discoverLocalhost } from "./discovery/engine.ts";
import { createProbe } from "./discovery/probe.ts";
import { loadConfig, saveConfig } from "./registry/persistence.ts";
import { createPiCredentialStore } from "./registry/pi-credential-store.ts";
import { serverId } from "./registry/ids.ts";
import { ServerRegistry } from "./registry/registry.ts";
import { registerServer } from "./shim/provider-shim.ts";
import { openOnboarding } from "./ui/onboarding.ts";
import { installLoadedWidget, type LoadedWidgetHandle } from "./ui/loaded-widget.ts";

const HEALTH_POLL_MS = 15_000;

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

export default function crossbar(pi: ExtensionAPI): void {
  let registry: ServerRegistry | undefined;
  let widget: LoadedWidgetHandle | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const discover = (): Promise<DiscoveredServer[]> => discoverLocalhost([...DISCOVERY_ADAPTERS]);

  /** Best-effort: refresh a server's model list and (re)register it with Pi. Returns models used. */
  async function refreshAndRegister(reg: ServerRegistry, record: ServerRecord): Promise<number> {
    const adapter = adapterFor(record.kind);
    const cred = await reg.resolveCredential(record);
    let models: ModelDescriptor[] = record.lastKnownModels ?? [];
    try {
      const probe = createProbe(record.baseUrl, { auth: cred });
      models = await adapter.listModels(recordToServer(record), cred, probe);
      reg.updateHealthCache(record.id, { models, lastSeenAt: Date.now() });
    } catch {
      // Offline / unreachable — fall back to last-known models (may be empty).
    }
    if (models.length === 0) return 0; // nothing registrable (server offline, no cache)
    await registerServer(pi, reg, record, models);
    return models.length;
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Rebuild cleanly on every start/reload.
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }

    const store = createPiCredentialStore(ctx.modelRegistry.authStorage);
    const reg = new ServerRegistry({ store, persist: (cfg) => saveConfig(cfg) });
    reg.load(await loadConfig());
    registry = reg;

    // 1) Register every enabled server from the saved config.
    for (const record of reg.list()) {
      if (!record.enabled) continue;
      try {
        await refreshAndRegister(reg, record);
      } catch {
        // Never let one bad server abort startup.
      }
    }

    // 2) Auto-discover localhost; auto-register reachable no-auth servers, prompt for keyed ones.
    try {
      const found = await discover();
      for (const srv of found) {
        const id = serverId(srv.kind, srv.baseUrl);
        if (reg.get(id)) continue; // already known
        if (srv.auth !== "none") {
          if (ctx.hasUI) {
            ctx.ui.notify(`Crossbar: found ${srv.label} (needs an API key) — run /crossbar to add it.`, "info");
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

    // 3) Loaded-model widget + health poll (UI modes only).
    if (ctx.hasUI) {
      widget = installLoadedWidget(pi, ctx, reg);
      await widget.refresh();
      pollTimer = setInterval(() => {
        void widget?.refresh();
      }, HEALTH_POLL_MS);
    }
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    widget?.dispose();
    widget = undefined;
  });

  const openCmd = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!registry) {
      ctx.ui.notify("Crossbar is still initialising — try again in a moment.", "warning");
      return;
    }
    await openOnboarding(pi, ctx, { registry, discover });
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
