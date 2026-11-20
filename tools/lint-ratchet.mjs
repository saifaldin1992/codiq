#!/usr/bin/env node
/**
 * ESLint ratchet. Errors fail outright. Warnings are counted per rule and may
 * never rise above `tools/lint-baseline.json`; when they fall, the run says so
 * and `--update` writes the lower numbers (commit that file). New code is held
 * to zero; old debt can only shrink.
 *
 * The security warnings in the baseline were reviewed on 2026-11-20 (see
 * docs/ASVS_L2_REVIEW.md, V5/V11): the «unsafe regex» hits are bounded or
 * separator-delimited patterns timed at < 1 ms on 50,000-character attack
 * input; the fs/regexp hits build paths and patterns from constants.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BASELINE = new URL("./lint-baseline.json", import.meta.url);
const run = spawnSync("npx", ["eslint", ".", "-f", "json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (!run.stdout) { console.error(run.stderr); process.exit(2); }
const results = JSON.parse(run.stdout);

const errors = [];
const counts = {};
for (const file of results) {
  for (const message of file.messages) {
    const rule = message.ruleId ?? "(parse)";
    if (message.severity === 2) errors.push(`${file.filePath.replace(process.cwd() + "/", "")}:${message.line} ${rule} — ${message.message}`);
    else counts[rule] = (counts[rule] ?? 0) + 1;
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + "\n");
  console.log("lint baseline written:", counts);
  process.exit(errors.length ? 1 : 0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const rose = Object.entries(counts).filter(([rule, n]) => n > (baseline[rule] ?? 0)).map(([rule, n]) => `${rule}: ${baseline[rule] ?? 0} → ${n}`);
const fell = Object.entries(baseline).filter(([rule, n]) => (counts[rule] ?? 0) < n).map(([rule, n]) => `${rule}: ${n} → ${counts[rule] ?? 0}`);

if (errors.length) console.error(`✗ ${errors.length} lint error(s):\n  ${errors.slice(0, 50).join("\n  ")}`);
if (rose.length) console.error(`✗ warnings rose above the baseline (fix them, do not raise the baseline):\n  ${rose.join("\n  ")}`);
if (fell.length) console.log(`✓ debt fell — run \`pnpm lint:ratchet --update\` and commit tools/lint-baseline.json:\n  ${fell.join("\n  ")}`);
if (errors.length || rose.length) process.exit(1);
console.log(JSON.stringify({ suite: "lint-ratchet", status: "passed", errors: 0, warnings: Object.values(counts).reduce((a, b) => a + b, 0) }));
