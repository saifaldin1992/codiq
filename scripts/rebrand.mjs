#!/usr/bin/env node
/**
 * Rebrand this template: replaces the DISPLAY brand and the public domain.
 *
 *   node scripts/rebrand.mjs --name "Souqly" --domain souqly.com [--dry-run]
 *
 * Safe by construction: the display brand is written exactly «Codiq» (one
 * capital) everywhere, which `brand-name.guard.mjs` enforces, while identifiers
 * are `codiq…` / `CODIQ_…` and are never matched. So this script NEVER touches:
 *   - environment variable names (CODIQ_*), the backup magic (CODIQBK1),
 *   - CSS tokens (--codiq-*), the session cookie (codiq_session),
 *   - package names, file names, or anything lower/upper-cased.
 * Afterwards run `pnpm openapi:generate && pnpm check && pnpm brand:guard`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const name = arg("--name");
const domain = arg("--domain");
const dryRun = args.includes("--dry-run");

if (!name && !domain) {
  console.error(
    'usage: node scripts/rebrand.mjs --name "Brand" [--domain example.com] [--dry-run]'
  );
  process.exit(2);
}
if (name && !/^[\p{L}\p{N} .&'-]{2,40}$/u.test(name)) {
  console.error("--name must be 2-40 letters, digits, spaces or .&'-");
  process.exit(2);
}
if (name && /^CODIQ$/i.test(name)) {
  console.error("--name is already the current brand");
  process.exit(2);
}
if (domain && !/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) {
  console.error("--domain must be a bare lowercase host, e.g. example.com");
  process.exit(2);
}

const TARGETS = ["client/src", "client/index.html", "phase1-backend/src", "server"];
const EXTENSIONS = /\.(tsx?|html|mjs)$/;
const GENERATED = path.join("phase1-backend", "src", "http", "openapi.document.ts");

function walk(target) {
  const full = path.join(root, target);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((entry) => walk(path.join(target, entry)));
}

const BRAND = /\bCodiq\b/g;
const DOMAIN = /\bcodiqos\.com\b/g;
let filesChanged = 0;
let replacements = 0;
for (const file of TARGETS.flatMap(walk)) {
  if (!EXTENSIONS.test(file) || file.endsWith(GENERATED)) continue;
  const before = readFileSync(file, "utf8");
  let count = 0;
  let after = before;
  if (name) after = after.replace(BRAND, () => ((count += 1), name));
  if (domain) after = after.replace(DOMAIN, () => ((count += 1), domain));
  if (after === before) continue;
  filesChanged += 1;
  replacements += count;
  console.log(`${dryRun ? "would change" : "changed"} ${path.relative(root, file)} (${count})`);
  if (!dryRun) writeFileSync(file, after);
}
console.log(
  JSON.stringify({ name: name ?? null, domain: domain ?? null, dryRun, filesChanged, replacements })
);
if (!dryRun && filesChanged)
  console.log("Next: pnpm openapi:generate && pnpm check && pnpm brand:guard");
