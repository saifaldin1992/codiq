/**
 * المرحلة 21 — collapse the shades that are the SAME COLOUR onto their token.
 *
 * ============================================================================
 * WHAT THE MEASUREMENT SHOWED
 * ============================================================================
 *
 * The debt looked like 458 distinct colours. It is not. Sorted by CIE-Lab
 * distance to the nearest existing token, the occurrences fall out like this:
 *
 *   ΔE 0–1   185   ΔE 3–5   278   ΔE 8–12  251
 *   ΔE 1–2   276   ΔE 5–8   279   ΔE 12+   172
 *
 * **461 of them sit within ΔE 2 of a token that already exists.** ΔE 2 is the
 * threshold below which a trained eye, side by side, under controlled light,
 * can only just tell two colours apart; across two monitors and a page of
 * chrome it is nothing. Six near-identical greys were being used for one
 * «muted text» role, five for «secondary», four for a tinted well.
 *
 * So this is not a re-colouring. It is deleting duplicates of the same
 * decision, and the pixel cost is below the threshold of sight.
 *
 * ============================================================================
 * WHERE IT WILL AND WILL NOT SUBSTITUTE
 * ============================================================================
 *
 * Only two contexts, because only these are certainly CSS:
 *
 *   1. a Tailwind arbitrary value — `text-[#51607A]` → `text-[var(--…)]`
 *   2. a JSX presentation attribute — `fill="#…"`, `stroke="#…"`, `color="#…"`
 *
 * Everything else is REPORTED AND LEFT ALONE. A hex passed as a positional
 * argument (`bar(12, 14, 56, 8, "#C9D8EE")` in `DeviceShowcase`) reaches an SVG
 * `fill` today and would survive the substitution — but the next such helper
 * might paint to a canvas, where `var()` is not a colour, and the failure would
 * be an invisible chart rather than an error. A tool that rewrites code it
 * cannot prove the meaning of is the kind of tool this repository keeps finding
 * in its own history.
 *
 * ============================================================================
 * DRY BY DEFAULT
 * ============================================================================
 *
 * Prints what it would do and changes nothing. `--apply` writes.
 * `--max-delta <n>` moves the threshold; above 2 it is a design decision and
 * the number belongs in a decision record, not in a habit.
 *
 * Run: pnpm theme:collapse            (dry run, ΔE ≤ 2)
 *      pnpm theme:collapse --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = fileURLToPath(new URL("../../client/src", import.meta.url));
const CSS = path.join(CLIENT_SRC, "index.css");
const LEDGER = fileURLToPath(new URL("../tests/theme-tokens.legacy.json", import.meta.url));

const apply = process.argv.includes("--apply");
const deltaIndex = process.argv.indexOf("--max-delta");
const MAX_DELTA = deltaIndex === -1 ? 2 : Number(process.argv[deltaIndex + 1]);
if (!Number.isFinite(MAX_DELTA) || MAX_DELTA <= 0) throw new Error("--max-delta needs a positive number");

/** sRGB → CIE-Lab, so the distance below is perceptual rather than arithmetic. */
const linear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function lab(hex) {
  const r = linear(parseInt(hex.slice(1, 3), 16));
  const g = linear(parseInt(hex.slice(3, 5), 16));
  const b = linear(parseInt(hex.slice(5, 7), 16));
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const tokens = [];
for (const match of readFileSync(CSS, "utf8").matchAll(/(--codiq-[a-z-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) {
  tokens.push({ name: match[1], lab: lab(match[2].toUpperCase()) });
}
if (!tokens.length) throw new Error("no --codiq-* colour tokens found in index.css");

/** hex → the token it collapses onto, when one is close enough. */
const nearest = new Map();
function resolve(hex) {
  if (nearest.has(hex)) return nearest.get(hex);
  const target = lab(hex);
  let best = null;
  let bestDistance = Infinity;
  for (const token of tokens) {
    const d = distance(target, token.lab);
    if (d < bestDistance) { bestDistance = d; best = token; }
  }
  const answer = bestDistance <= MAX_DELTA ? { token: best.name, delta: bestDistance } : null;
  nearest.set(hex, answer);
  return answer;
}

/**
 * THE ONE RULE THAT IS NOT ABOUT DISTANCE, and it exists because the brand mark
 * nearly taught it the expensive way.
 *
 * `BrandMark` draws a white letter on a blue disc. `#FFFFFF` is EXACTLY the
 * value of `--codiq-surface` — ΔE 0, the safest substitution this script can
 * make by its own measure — and making it would flip that letter dark under a
 * dark theme and erase the logo inside its own coin. The colour was never «a
 * card surface»; it was ink that must stay light because of what sits BEHIND
 * it, and nothing about the hex says so.
 *
 * Generalised: a LIGHT colour in a FOREGROUND position is paired with a
 * background this script cannot see. Its token will move with the theme; the
 * background may not. So those are skipped and counted, for a human to place.
 *
 * The reverse — a light colour as a background, a dark colour as text — is the
 * ordinary case the tokens were designed for, and passes.
 */
const FOREGROUND_UTILITY = /(?:^|[\s"'`:])(?:text|fill|stroke|placeholder|caret|decoration|accent|ring-offset)-$/;
const LIGHTNESS_CEILING = 85;
const isLight = (hex) => lab(hex)[0] > LIGHTNESS_CEILING;

const ARBITRARY = /\[#([0-9A-Fa-f]{6})\b/g;
const ATTRIBUTE = /\b(fill|stroke|color|stopColor|floodColor)="#([0-9A-Fa-f]{6})\b"/g;
const ANY_HEX = /#[0-9A-Fa-f]{6}\b/g;

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
let substituted = 0;
let skippedContext = 0;
let skippedDistance = 0;
let skippedLightForeground = 0;
const perFile = [];
const usedTokens = new Map();

for (const relative of Object.keys(ledger)) {
  const file = path.join(CLIENT_SRC, relative);
  const before = readFileSync(file, "utf8");
  let count = 0;

  let after = before.replace(ARBITRARY, (whole, hex, offset, source) => {
    const value = `#${hex.toUpperCase()}`;
    const hit = resolve(value);
    if (!hit) return whole;
    // The utility that owns this bracket decides whether the colour is ink.
    if (FOREGROUND_UTILITY.test(source.slice(Math.max(0, offset - 24), offset)) && isLight(value)) {
      skippedLightForeground += 1;
      return whole;
    }
    count += 1;
    usedTokens.set(hit.token, (usedTokens.get(hit.token) ?? 0) + 1);
    return `[var(${hit.token})`;
  });
  after = after.replace(ATTRIBUTE, (whole, attribute, hex) => {
    const value = `#${hex.toUpperCase()}`;
    const hit = resolve(value);
    if (!hit) return whole;
    // fill/stroke/color are always ink. A light one is the brand-mark case.
    if (isLight(value)) {
      skippedLightForeground += 1;
      return whole;
    }
    count += 1;
    usedTokens.set(hit.token, (usedTokens.get(hit.token) ?? 0) + 1);
    return `${attribute}="var(${hit.token})"`;
  });

  // Whatever survives is either too far from any token, or sits somewhere this
  // tool will not touch. Counting the two separately is the point: the first
  // number is design work, the second is a decision about safety.
  for (const raw of after.match(ANY_HEX) ?? []) {
    if (resolve(raw.toUpperCase())) skippedContext += 1;
    else skippedDistance += 1;
  }

  if (count > 0) {
    substituted += count;
    perFile.push({ file: relative, substituted: count, remaining: (after.match(ANY_HEX) ?? []).length });
    if (apply) writeFileSync(file, after, "utf8");
  }
}

perFile.sort((a, b) => b.substituted - a.substituted);
console.log(JSON.stringify({
  suite: "theme-collapse",
  mode: apply ? "applied" : "dry-run",
  maxDelta: MAX_DELTA,
  summary: {
    substituted,
    filesTouched: perFile.length,
    skipped: {
      tooFarFromAnyToken: skippedDistance,
      closeEnoughButUnsafeContext: skippedContext,
      lightColourInForeground: skippedLightForeground,
    },
    tokensUsed: Object.fromEntries([...usedTokens].sort((a, b) => b[1] - a[1])),
  },
  files: perFile.slice(0, 20),
}, null, 2));
if (!apply) console.log("\nnothing was written. re-run with --apply.");
