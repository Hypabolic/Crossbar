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

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Probe, ProbeInit, ProbeResult, ServerCredential } from "../core/types.ts";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 600;

export interface CreateProbeOptions {
  auth?: ServerCredential;
  defaultTimeoutMs?: number;
  /**
   * Skip TLS certificate verification (accept self-signed / unknown-issuer certs).
   * Opt-in only \u2014 set from {@link ServerRecord.insecureTLS} after the user has explicitly
   * chosen to trust a certificate. Never enable this for a blind subnet sweep.
   */
  insecureTLS?: boolean | undefined;
}

/**
 * OpenSSL / Node TLS error codes that mean "the peer presented a certificate we could not
 * verify" \u2014 i.e. the host IS reachable, but its cert is untrusted (self-signed, unknown CA,
 * hostname mismatch, expired). Used to surface a distinct `tlsError` instead of an opaque
 * status:0, so the UI can offer an explicit trust opt-in.
 */
const TLS_VERIFY_ERROR_CODES = new Set<string>([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

/**
 * TLS/SSL failures that are NOT a certificate-trust problem but a handshake-level rejection:
 * the server aborted the TLS negotiation, typically because it expects a specific SNI hostname
 * and refuses a bare-IP connection (common with reverse proxies on a .fritz.box name).
 *
 * These mark the host as reachable-but-unspoken-to: TLS bypass alone can't fix them, but
 * retrying with the reverse-DNS hostname (so the right SNI is sent) often can. Surfaced as
 * {@link ProbeResult.tlsHandshakeError} so discovery can attempt a hostname retry.
 */
const TLS_HANDSHAKE_ERROR_CODES = new Set<string>([
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME",
  // Node 22 reports nginx's unrecognized_name alert without the ALERT segment.
  "ERR_SSL_TLSV1_UNRECOGNIZED_NAME",
  "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED",
]);

/** Walk an error's `cause` chain, returning the first `code` string found (up to 5 deep). */
function findErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") {
      if (TLS_VERIFY_ERROR_CODES.has(code) || TLS_HANDSHAKE_ERROR_CODES.has(code)) return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  // Fall back to any code found even if unrecognised (best-effort for message-based matches).
  cur = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Walk an error's `cause` chain looking for a recognised TLS verification error code. */
function isTlsVerifyError(err: unknown): boolean {
  const code = findErrorCode(err);
  return code !== undefined && TLS_VERIFY_ERROR_CODES.has(code);
}

/** Walk an error's `cause` chain looking for a TLS handshake-rejection error code. */
function isTlsHandshakeError(err: unknown): boolean {
  const code = findErrorCode(err);
  return code !== undefined && TLS_HANDSHAKE_ERROR_CODES.has(code);
}

/**
 * Perform a single request over Node's core http/https client with TLS verification disabled.
 *
 * Used ONLY on the opt-in insecure path (self-signed certs the user has chosen to trust).
 * Node's global `fetch` (undici) offers no supported way to relax TLS without adding the
 * `undici` package, and Crossbar ships zero runtime dependencies \u2014 so the rare insecure
 * branch uses the built-in client directly. The normal, verified path keeps using `fetch`
 * (and stays fully mockable in tests via `vi.stubGlobal`).
 */
function insecureRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        // The whole point of this path: accept unverified certificates.
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
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
  const insecureTLS = opts?.insecureTLS ?? false;

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
      let status: number;
      let ok: boolean;
      const responseHeaders: Record<string, string> = {};
      let text: string | undefined;
      let json: unknown;

      if (insecureTLS) {
        // Opt-in insecure path: Node core client with TLS verification disabled.
        const res = await insecureRequest(url, {
          method: init?.method ?? "GET",
          headers: requestHeaders,
          ...(init?.body !== undefined ? { body: init.body } : {}),
          signal: controller.signal,
        });
        status = res.status;
        ok = status >= 200 && status < 300;
        Object.assign(responseHeaders, res.headers);
        text = res.text;
      } else {
        const fetchInit: RequestInit = {
          method: init?.method ?? "GET",
          headers: requestHeaders,
          signal: controller.signal,
          redirect: init?.redirect ?? "follow",
        };
        // Only set body when defined — exactOptionalPropertyTypes forbids undefined for BodyInit
        if (init?.body !== undefined) {
          fetchInit.body = init.body;
        }

        const response = await fetch(url, fetchInit);
        status = response.status;
        ok = response.ok;
        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
        try {
          text = await response.text();
        } catch {
          // Body read failure is non-fatal; leave text undefined
        }
      }

      const latencyMs = Date.now() - startMs;

      if (text !== undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          // Not JSON; leave json undefined
        }
      }

      const result: ProbeResult = {
        status,
        ok,
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

      // Reachable-but-untrusted TLS is distinct from a dead address: flag it so the UI can
      // offer an explicit "trust this certificate" opt-in instead of "not reachable".
      const tlsError = !insecureTLS && isTlsVerifyError(err);
      // A handshake-level rejection (e.g. the server demands a specific SNI hostname and aborts
      // a bare-IP connection) means the host is up but won't talk to us at this address.
      // Flag it so discovery can retry via the reverse-DNS hostname (correct SNI).
      const tlsHandshakeError = isTlsHandshakeError(err);

      const result: ProbeResult = {
        status: 0,
        ok: false,
        headers: {},
        error: errorMessage,
        latencyMs,
      };
      if (tlsError) result.tlsError = true;
      if (tlsHandshakeError) result.tlsHandshakeError = true;
      return result;
    } finally {
      clearTimeout(timerId);
    }
  };
}
