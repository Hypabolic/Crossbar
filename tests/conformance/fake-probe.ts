/**
 * Fixture-backed fake Probe for the conformance test harness.
 *
 * `createFakeProbe` returns a Probe that resolves paths (and optionally HTTP
 * methods) against a caller-supplied route map. Unrecognised paths return
 * status 0, simulating a refused/unreachable connection. The caller can supply
 * plain ProbeResult values or factory functions for response-per-call variation
 * (e.g. a sequence of 200 followed by a 0 to simulate server-down-mid-switch).
 *
 * No network access; no external dependencies beyond core types.
 */

import type { Probe, ProbeInit, ProbeResult } from "../../src/core/types.ts";

/**
 * A route value is either:
 *  - a static `ProbeResult` returned on every match, or
 *  - a factory `(init?: ProbeInit) => ProbeResult` called on each probe.
 *
 * Key format: `"METHOD /path"` (e.g. `"GET /api/tags"`) OR just `"/path"` to
 * match any method.  Method-specific keys take priority over path-only keys.
 */
export type RouteMap = Record<string, ProbeResult | ((init?: ProbeInit) => ProbeResult)>;

// ---------------------------------------------------------------------------
// Well-known canned results that fixture authors can reference directly.
// ---------------------------------------------------------------------------

/** Simulates a connection-refused / timed-out probe (no HTTP response at all). */
export const REFUSED: ProbeResult = {
  status: 0,
  ok: false,
  headers: {},
  error: "connection refused",
};

/** Simulates a 401 Unauthorized response (running but keyed). */
export const UNAUTHORIZED: ProbeResult = {
  status: 401,
  ok: false,
  headers: { "content-type": "application/json" },
  json: { error: "Unauthorized" },
};

/** Simulates a generic server error. */
export const SERVER_ERROR: ProbeResult = {
  status: 500,
  ok: false,
  headers: {},
  json: { error: "internal server error" },
};

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Build a Probe backed by `routes`.
 *
 * Matching order:
 *   1. `"METHOD /path"` — exact method + path
 *   2. `"/path"` — path only (any method)
 *   3. fall-through → `REFUSED` (status 0)
 */
export function createFakeProbe(routes: RouteMap): Probe {
  return async function fakeProbe(path: string, init?: ProbeInit): Promise<ProbeResult> {
    const method = init?.method ?? "GET";

    // 1. Method-qualified key
    const methodKey = `${method} ${path}`;
    if (Object.prototype.hasOwnProperty.call(routes, methodKey)) {
      const entry = routes[methodKey]!;
      return typeof entry === "function" ? entry(init) : entry;
    }

    // 2. Path-only key
    if (Object.prototype.hasOwnProperty.call(routes, path)) {
      const entry = routes[path]!;
      return typeof entry === "function" ? entry(init) : entry;
    }

    // 3. No fixture → simulate refused connection
    return {
      status: 0,
      ok: false,
      headers: {},
      error: "no fixture",
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers for multi-call simulation (e.g. success then server-down)
// ---------------------------------------------------------------------------

/**
 * Returns a factory that cycles through `results` in order, repeating the
 * last entry once exhausted. Useful for simulating success-then-failure.
 *
 *   routes["/v1/models"] = sequence(OK_RESULT, REFUSED)
 *   // First call → OK_RESULT, second call → REFUSED, third call → REFUSED …
 */
export function sequence(...results: ProbeResult[]): (init?: ProbeInit) => ProbeResult {
  if (results.length === 0) throw new Error("sequence() requires at least one result");
  let index = 0;
  return (_init?: ProbeInit): ProbeResult => {
    const r = results[index]!;
    if (index < results.length - 1) index++;
    return r;
  };
}

/**
 * Returns a factory that always responds with a 401.  Convenience alias so
 * fixture authors can write: `routes["/v1/chat/completions"] = auth401()`.
 */
export function auth401(detail?: string): (init?: ProbeInit) => ProbeResult {
  return (): ProbeResult => ({
    status: 401,
    ok: false,
    headers: { "content-type": "application/json" },
    json: { error: detail ?? "Unauthorized" },
  });
}

/**
 * Returns a factory that simulates a timeout / connection-refused.
 */
export function timeout(reason?: string): (init?: ProbeInit) => ProbeResult {
  return (): ProbeResult => ({
    status: 0,
    ok: false,
    headers: {},
    error: reason ?? "timeout",
  });
}
