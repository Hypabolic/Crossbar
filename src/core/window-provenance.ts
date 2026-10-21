/**
 * Window provenance — the (window, source) contract for context-window reporting.
 *
 * Every context window crossbar knows about carries a source label — `declared` or `observed`
 * (see `WindowProvenance` in `types.ts`) — and a trained ceiling never becomes a serviceable
 * window. `ModelDescriptor.contextWindow` is set iff `contextWindowSource` is set; the
 * conformance suite enforces the pairing for every adapter.
 *
 * The Pi boundary: Pi's model type REQUIRES a numeric `contextWindow`, so an unknown window
 * cannot be omitted at registration. Every adapter's `toPiModel` emits the uniform,
 * most-conservative legacy value {@link UNKNOWN_CONTEXT_WINDOW} for unknown windows — the
 * descriptor and registry still report unknown, only the mandatory boundary number is filled.
 */

import type { ModelDescriptor } from "./types.ts";

/**
 * The single uniform context window `toPiModel` emits when the effective window is unknown.
 * 8192 is the most conservative value among the previous per-adapter fallbacks (it was the
 * default in 5 of 7 adapters), so the switch from per-adapter values is safe-direction
 * only — understated, never overstated.
 */
export const UNKNOWN_CONTEXT_WINDOW = 8192 as const;

/** True when the descriptor carries a well-formed (window, source) pair. */
export function hasProvenancedWindow(model: ModelDescriptor): boolean {
  return (
    typeof model.contextWindow === "number" &&
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow > 0 &&
    (model.contextWindowSource === "declared" || model.contextWindowSource === "observed")
  );
}

/**
 * The context window a `toPiModel` must emit: the descriptor's window (positive safe integer,
 * paired or legacy-bare) when present, else {@link UNKNOWN_CONTEXT_WINDOW}. Pairing is
 * enforced on adapter OUTPUT (listModels) and on cache migration — this boundary accepts
 * what the descriptor holds and never invents a different number.
 */
export function piContextWindow(model: ModelDescriptor): number {
  const window = model.contextWindow;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0
    ? window
    : UNKNOWN_CONTEXT_WINDOW;
}

/**
 * Merge a persisted (cached) catalogue with a freshly listed one, applying the
 * precedence ladder per model.
 *
 * Ladder: live evidence beats persisted evidence, and persisted evidence fills models the
 * live list reports no window for. "Live evidence" is whatever the adapter's own chain
 * produced — each adapter already applies declared > observed internally (e.g. llama.cpp's
 * pinned `-c` beats the loaded runtime `n_ctx`) — so a live descriptor always outranks a
 * persisted one regardless of the persisted source.
 *
 * Models are returned in the live list's order and membership: a model absent from the live
 * list is never resurrected (registration only ever reflects the live catalogue), and a
 * model present live keeps its live `id`/`name`/caps — only the window fields (and, when the
 * live list is silent, `trainedMax`) may come from the cache.
 *
 * PURE — no I/O, no mutation of the inputs.
 */
export function mergeCatalogue(
  persisted: ModelDescriptor[] | undefined,
  live: ModelDescriptor[],
): ModelDescriptor[] {
  const persistedById = new Map<string, ModelDescriptor>();
  for (const p of persisted ?? []) {
    if (typeof p === "object" && p !== null && typeof p.id === "string") {
      persistedById.set(p.id, p);
    }
  }

  return live.map((m) => {
    if (hasProvenancedWindow(m)) return m;

    const p = persistedById.get(m.id);
    const pWindow = p?.contextWindow;
    const pSource = p?.contextWindowSource;
    if (
      p &&
      typeof pWindow === "number" &&
      Number.isSafeInteger(pWindow) &&
      pWindow > 0 &&
      (pSource === "declared" || pSource === "observed")
    ) {
      const out: ModelDescriptor = {
        ...m,
        contextWindow: pWindow,
        contextWindowSource: pSource,
      };
      if (p.contextWindowAt !== undefined) out.contextWindowAt = p.contextWindowAt;
      if (out.trainedMax === undefined && p.trainedMax !== undefined) {
        out.trainedMax = p.trainedMax;
      }
      return out;
    }
    if (p && m.trainedMax === undefined && p.trainedMax !== undefined) {
      return { ...m, trainedMax: p.trainedMax };
    }
    return m;
  });
}
