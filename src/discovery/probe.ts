/**
 * Real `Probe` factory for the Crossbar discovery engine.
 *
 * Wraps Node's global `fetch` with:
 *  - URL resolution of `path` against `baseUrl`
 *  - `Authorization: Bearer <key>` injection when `auth.mode === "apiKey"` (key never logged)
 *  - Per-request timeout via AbortController (default 600 ms)
 *  - Lossless error capture: refused / DNS / timeout → `{ status: 0, ok: false, error: "..." }`
 *  - Response body read into `text` + best-effort `json`
 *  - Lowercased `headers` map
 *  - `latencyMs` measurement
 *
 * No network I/O outside the returned `Probe` function; the factory itself is pure.
 */

import type { Probe, ProbeInit, ProbeResult, ServerCredential } from "../core/types.ts";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 600;

export interface CreateProbeOptions {
  auth?: ServerCredential;
  defaultTimeoutMs?: number;
}

/**
 * Build a `Probe` bound to `baseUrl`.
 *
 * @param baseUrl - Normalized server origin (no trailing slash).  `path` values starting with `/`
 *                  are resolved against this origin; otherwise they are treated as relative paths.
 * @param opts    - Optional auth credential and per-probe timeout override.
 */
export function createProbe(baseUrl: string, opts?: CreateProbeOptions): Probe {
  const defaultTimeout = opts?.defaultTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const auth = opts?.auth;

  return async function probe(path: string, init?: ProbeInit): Promise<ProbeResult> {
    // ── URL resolution ──────────────────────────────────────────────────────────
    // Normalise baseUrl to have no trailing slash, then join with the path.
    const base = baseUrl.replace(/\/+$/, "");
    const url = path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${base}${path.startsWith("/") ? path : `/${path}`}`;

    // ── Request headers ─────────────────────────────────────────────────────────
    const requestHeaders: Record<string, string> = {};

    // Inject auth header when configured — key is never exposed in logs or results
    if (auth?.mode === "apiKey" && auth.apiKey) {
      requestHeaders["authorization"] = `Bearer ${auth.apiKey}`;
    }

    // Merge caller-supplied headers (allow override of everything except the auth key value,
    // so callers can set content-type etc.)
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        // Never let a caller accidentally expose the raw key by overriding authorization with it
        requestHeaders[k.toLowerCase()] = v;
      }
    }

    // ── Timeout ─────────────────────────────────────────────────────────────────
    const timeoutMs = init?.timeoutMs ?? defaultTimeout;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);

    const startMs = Date.now();

    try {
      const fetchInit: RequestInit = {
        method: init?.method ?? "GET",
        headers: requestHeaders,
        signal: controller.signal,
      };
      // Only set body when defined — exactOptionalPropertyTypes forbids undefined for BodyInit
      if (init?.body !== undefined) {
        fetchInit.body = init.body;
      }

      const response = await fetch(url, fetchInit);

      const latencyMs = Date.now() - startMs;

      // ── Collect response headers (lowercase keys) ────────────────────────────
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      // ── Read body ────────────────────────────────────────────────────────────
      let text: string | undefined;
      let json: unknown;

      try {
        text = await response.text();
      } catch {
        // Body read failure is non-fatal; leave text undefined
      }

      if (text !== undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          // Not JSON; leave json undefined
        }
      }

      const result: ProbeResult = {
        status: response.status,
        ok: response.ok,
        headers: responseHeaders,
        latencyMs,
      };
      // exactOptionalPropertyTypes: only set optional fields when they have a value
      if (text !== undefined) result.text = text;
      if (json !== undefined) result.json = json;
      return result;
    } catch (err: unknown) {
      const latencyMs = Date.now() - startMs;

      // Classify the failure — never include the api key in the error message
      let errorMessage: string;
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          errorMessage = `Request timed out after ${timeoutMs}ms`;
        } else {
          // Scrub potential URL fragments that might contain keys; keep the message generic
          errorMessage = err.message.replace(/authorization=[^\s&]*/gi, "authorization=[redacted]");
        }
      } else {
        errorMessage = "Unknown fetch error";
      }

      return {
        status: 0,
        ok: false,
        headers: {},
        error: errorMessage,
        latencyMs,
      };
    } finally {
      clearTimeout(timerId);
    }
  };
}
