#!/usr/bin/env node
/**
 * Generate docs/onboarding.gif — a scripted render of the Crossbar `/crossbar`
 * flow (discover → manage → switch model), driven against the fake LM Studio
 * server's model set (scripts/fake-lmstudio.mjs).
 *
 * This is a deterministic *render* of the overlay frames (same layout, labels and
 * theme tokens the TUI produces), not a screen-capture — so it needs no terminal
 * recorder and reproduces identically anywhere.
 *
 * Requires two dev-only libraries that are intentionally NOT in package.json (to
 * keep normal installs/CI lean). Install them on demand:
 *
 *   npm i --no-save @napi-rs/canvas gifenc
 *   node scripts/gen-onboarding-gif.mjs
 *
 * Output: docs/onboarding.gif
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
const gifenc = await import("gifenc");
const { GIFEncoder, quantize, applyPalette } = gifenc.default ?? gifenc;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "Mono");

// ── Theme (Catppuccin Mocha-ish, mapped from Crossbar's theme tokens) ─────────
const C = {
  bg: "#181825",
  fg: "#cdd6f4",
  accent: "#89b4fa",
  success: "#a6e3a1",
  muted: "#9399b2",
  dim: "#6c7086",
  warning: "#f9e2af",
};

const COLS = 74;
const FONT_PX = 20;
const PAD = 18;

// ── Cell metrics ──────────────────────────────────────────────────────────────
const probe = createCanvas(40, 40).getContext("2d");
probe.font = `${FONT_PX}px Mono`;
const CELL_W = probe.measureText("M").width;
const CELL_H = Math.round(FONT_PX * 1.5);

// ── Frame composition helpers ────────────────────────────────────────────────
// A line is an array of { t: text, c: color } spans. Rows render label + desc.
const span = (t, c = C.fg) => ({ t, c });
const line = (...spans) => spans;
const blank = () => [];
const border = () => line(span("─".repeat(COLS), C.accent));

function rowLine(marker, label, labelColor, desc) {
  const labelW = 30; // wide enough to keep a clear gap before the description
  const trimmed = label.length > labelW - 2 ? label.slice(0, labelW - 2) : label;
  const padded = trimmed.padEnd(labelW);
  const spans = [span(marker, C.accent), span(padded, labelColor)];
  if (desc) spans.push(span(desc, C.dim));
  return spans;
}

/** Build an overlay frame: bordered title/subtitle + cursor-highlighted list + hint. */
function overlay({ title, subtitle, rows, cursor, hint }) {
  const lines = [border(), line(span(title, C.accent)), blank()];
  if (subtitle) {
    lines.splice(2, 0, line(span(subtitle, C.muted)));
  }
  rows.forEach((r, i) => {
    const selected = i === cursor;
    const marker = selected ? "▌ " : "  ";
    const labelColor = selected ? C.fg : C.muted;
    lines.push(rowLine(marker, r.label, labelColor, r.desc));
  });
  lines.push(blank(), line(span(hint, C.dim)), border());
  return lines;
}

/** Build a plain "screen" frame from raw lines (for toasts / status bar). */
const screen = (lines) => lines;

// ── Storyboard ────────────────────────────────────────────────────────────────
const SERVER = "LM Studio (127.0.0.1:1234)";

const discovery = (cursor) =>
  overlay({
    title: "Crossbar — Local Model Servers",
    subtitle: "Select a discovered server or add one manually.",
    rows: [
      { label: SERVER, desc: "Already registered · (added)" },
      { label: "Ollama (127.0.0.1:11434)", desc: "✓ healthy · auth: none" },
      { label: "+ Add server…", desc: "Enter a URL manually" },
    ],
    cursor,
    hint: "↑↓ navigate · Enter select · Esc cancel",
  });

const manage = (cursor) =>
  overlay({
    title: `Manage — ${SERVER}`,
    rows: [
      { label: "Switch model", desc: "Make a model the active/served one" },
      { label: "Load model", desc: "Load a model into memory" },
      { label: "Unload model", desc: "Evict a loaded model from memory" },
      { label: "Inspect loaded", desc: "Show which models are loaded" },
      { label: "Remove server", desc: "Forget this server and delete its key" },
    ],
    cursor,
    hint: "↑↓ navigate · Enter select · Esc close",
  });

const modelPicker = (cursor) =>
  overlay({
    title: `Switch model — ${SERVER}`,
    rows: [
      { label: "qwen2.5-coder-7b", desc: "16k ctx  reasoning · tools" },
      { label: "llama-3.2-3b", desc: "128k ctx  tools" },
      { label: "llava-1.5-7b", desc: "8k ctx  vision" },
    ],
    cursor,
    hint: "↑↓ navigate · Enter select · Esc cancel",
  });

const toast = (spans) =>
  screen([blank(), blank(), blank(), blank(), blank(), blank(), spans]);

const FRAMES = [
  { f: toast([span("• Crossbar: scanning localhost for backends…", C.muted)]), ms: 900 },
  { f: discovery(0), ms: 1500 },
  { f: manage(0), ms: 1700 },
  { f: modelPicker(0), ms: 1700 },
  { f: toast([span("• Crossbar: switching to qwen2.5-coder-7b…", C.accent)]), ms: 1000 },
  {
    f: screen([
      blank(),
      blank(),
      blank(),
      blank(),
      blank(),
      line(span("✓ Crossbar: qwen2.5-coder-7b is now active.", C.success)),
      blank(),
      line(span("● LM Studio:qwen2.5-coder-7b", C.accent)),
    ]),
    ms: 2100,
  },
];

// ── Rasterise + encode ────────────────────────────────────────────────────────
const ROWS = Math.max(...FRAMES.map((fr) => fr.f.length));
const W = Math.round(COLS * CELL_W + PAD * 2);
const H = Math.round(ROWS * CELL_H + PAD * 2);

function renderFrameTo(canvas, lines) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.font = `${FONT_PX}px Mono`;
  ctx.textBaseline = "top";

  lines.forEach((spans, row) => {
    let col = 0;
    const y = PAD + row * CELL_H;
    for (const s of spans) {
      ctx.fillStyle = s.c;
      ctx.fillText(s.t, PAD + col * CELL_W, y);
      col += s.t.length;
    }
  });
  return ctx.getImageData(0, 0, W, H);
}

const gif = GIFEncoder();
FRAMES.forEach(({ f, ms }, i) => {
  const canvas = createCanvas(W, H);
  const img = renderFrameTo(canvas, f);
  const palette = quantize(img.data, 256);
  const index = applyPalette(img.data, palette);
  gif.writeFrame(index, W, H, { palette, delay: ms });
  if (process.env.DEBUG_FRAMES) {
    mkdirSync(join(ROOT, "docs", "_frames"), { recursive: true });
    writeFileSync(join(ROOT, "docs", "_frames", `f${i}.png`), canvas.toBuffer("image/png"));
  }
});
gif.finish();

mkdirSync(join(ROOT, "docs"), { recursive: true });
const out = join(ROOT, "docs", "onboarding.gif");
writeFileSync(out, gif.bytes());
console.log(`wrote ${out} (${W}x${H}, ${FRAMES.length} frames, ${gif.bytes().length} bytes)`);
