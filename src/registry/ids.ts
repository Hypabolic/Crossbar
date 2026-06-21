/**
 * Stable, deterministic server ID generation.
 *
 * IDs are derived from kind + host + port so the same physical server always gets the same id
 * across restarts. The id is also used as the Pi provider name and as the auth.json key.
 */

import { CLOUD_KINDS } from "../core/capability.ts";
import type { BackendKind } from "../core/capability.ts";

/**
 * Sanitize a URL component to be safe for use in an id string.
 * Replaces any character that isn't alphanumeric with a hyphen, collapses runs.
 */
function sanitize(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * Generate a stable id for a server of the given kind at the given base URL.
 *
 * Cloud kinds (openai, anthropic) have no meaningful host/port variation:
 *   → `crossbar-openai`, `crossbar-anthropic`
 *
 * Local kinds embed the host and port:
 *   → `crossbar-ollama-127-0-0-1-11434`
 *
 * The id is fully deterministic: same kind + baseUrl → same id every time.
 */
export function serverId(kind: BackendKind, baseUrl: string): string {
  if (CLOUD_KINDS.has(kind)) {
    return `crossbar-${kind}`;
  }

  let host: string;
  let port: string;
  try {
    const u = new URL(baseUrl);
    host = u.hostname;
    port = u.port || defaultPortForProtocol(u.protocol);
  } catch {
    // Fallback: sanitize the raw string
    return `crossbar-${kind}-${sanitize(baseUrl)}`;
  }

  const hostPart = sanitize(host);
  const portPart = sanitize(port);

  const parts = ["crossbar", kind, hostPart];
  if (portPart) parts.push(portPart);
  return parts.join("-");
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}

/**
 * Derive the env-var name for the api-key associated with a server id.
 * The env var name is the id uppercased with hyphens replaced by underscores,
 * so `crossbar-ollama-127-0-0-1-11434` → `CROSSBAR_OLLAMA_127_0_0_1_11434`.
 * This is the name used for the `$ENV` handoff in Pi's registerProvider apiKey field.
 */
export function envVarFor(id: string): string {
  return id.toUpperCase().replace(/-/g, "_");
}
