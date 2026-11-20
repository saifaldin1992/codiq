/**
 * المرحلة 21 — the half a hex check cannot see: `bg-white`, `text-white`.
 *
 * `theme:guard` counts these and enforces nothing, with an honest note on every
 * run: «…plus 456 literal white/black utilities, which no hex check can see and
 * dark mode will still break on». `bg-white` is exactly as unthemeable as
 * `bg-[#FFFFFF]`; it simply is not a hex.
 *
 * ============================================================================
 * THREE ANSWERS, NOT ONE — and they were measured, not assumed
 * ============================================================================
 *
 *   bg-white        278  → a SURFACE. Collapses.
 *   border-white     58  → 59 of the lines carrying it also carry `bg-white`:
 *                          it is the edge of the white card itself. Collapses.
 *   text-white       76  → INK, and every sample sits on a coloured fill:
 *                          `bg-[var(--codiq-accent)] text-white`. Left alone —
 *                          collapsing it inverts the label on every primary
 *                          button the moment a dark theme exists.
 *   bg-black/50       9  → a modal scrim, always with opacity. Left alone twice
 *                          over: a scrim is black by intent, not by theme, and
 *                          Tailwind cannot apply `/50` to an arbitrary var.
 *
 * ============================================================================
 * THE OPACITY TRAP
 * ============================================================================
 *
 * `bg-white/70` CANNOT become `bg-[var(--codiq-surface)]/70`. Tailwind composes
 * an opacity modifier by splitting a colour into channels, and it cannot do
 * that to a `var()` whose value it never sees — the modifier is silently
 * dropped and a translucent panel turns opaque. Twenty-two of those exist, and
 * every one is skipped by construction: the pattern requires the utility to end
 * at a word boundary that is not `/`.
 *
 * Dry by default. `--apply` writes.
 *
 * Run: pnpm theme:literals            (dry run)
 *      pnpm theme:literals --apply
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = fileURLToPath(new URL("../../client/src", import.meta.url));
const apply = process.argv.includes("--apply");

/**
 * A background or a border may follow the theme. Ink may not — see the header.
 * The negative lookahead is what keeps every `/opacity` variant out.
 */
const COLLAPSIBLE = /\b(bg|border|divide)-white(?![-\w/])/g;
const INK = /\b(text|fill|stroke|placeholder|caret|decoration|from|via|to)-(white|black)(?![-\w])/g;
const SCRIM = /\bbg-black(?:\/\d+)?(?![-\w])/g;
const WITH_OPACITY = /\b(?:bg|border|divide|text)-(?:white|black)\/\d+/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

let collapsed = 0;
let leftInk = 0;
let leftScrim = 0;
let leftOpacity = 0;
const perFile = [];

for (const file of walk(CLIENT_SRC)) {
  const before = readFileSync(file, "utf8");
  let count = 0;
  const after = before.replace(COLLAPSIBLE, (whole, utility) => {
    count += 1;
    return `${utility}-[var(--codiq-surface)]`;
  });
  leftInk += (after.match(INK) ?? []).length;
  leftScrim += (after.match(SCRIM) ?? []).length;
  leftOpacity += (after.match(WITH_OPACITY) ?? []).length;
  if (count > 0) {
    collapsed += count;
    perFile.push({ file: path.relative(CLIENT_SRC, file).split(path.sep).join("/"), collapsed: count });
    if (apply) writeFileSync(file, after, "utf8");
  }
}

perFile.sort((a, b) => b.collapsed - a.collapsed);
console.log(JSON.stringify({
  suite: "theme-literals",
  mode: apply ? "applied" : "dry-run",
  summary: {
    collapsed,
    filesTouched: perFile.length,
    leftAlone: {
      ink: leftInk,
      scrim: leftScrim,
      withOpacity: leftOpacity,
    },
  },
  files: perFile.slice(0, 15),
}, null, 2));
if (!apply) console.log("\nnothing was written. re-run with --apply.");
