/**
 * The CI workflow must be valid YAML — and must still run what it claims.
 *
 * Found in the review of 2026-11-21: a step NAME with «: » inside it (a
 * description like «(concurrency: no double spend)») made .github/workflows/
 * ci.yml invalid YAML. GitHub then rejects the WHOLE workflow: no job runs,
 * nothing turns red, and seven commits went by with no CI at all. A broken
 * workflow cannot report itself, so this guard runs it through a real YAML
 * parser, and it is part of every local guard pass as well as CI.
 *
 *   1. it parses;
 *   2. every job has steps, every step a `run` or a `uses`;
 *   3. every `pnpm <script>` a step runs exists in package.json, and every
 *      test file a step runs with node exists — a renamed script is not a
 *      silently skipped check;
 *   4. every marketplace integration and browser suite in the repository is
 *      run by some step.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const raw = readFileSync(".github/workflows/ci.yml", "utf8");
let workflow;
try { workflow = parse(raw); } catch (error) { assert.fail(`ci.yml is not valid YAML — GitHub would run NOTHING: ${error.message}`); }
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const problems = [];
const ran = new Set();
for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
  if (!Array.isArray(job.steps) || !job.steps.length) { problems.push(`job ${jobName} has no steps`); continue; }
  for (const step of job.steps) {
    if (!step.run && !step.uses) problems.push(`${jobName}: step «${step.name}» has neither run nor uses`);
    for (const line of String(step.run ?? "").split("\n")) {
      for (const match of line.matchAll(/\bpnpm (?:-s )?([a-z0-9][a-z0-9:_-]*)/g)) {
        const name = match[1];
        if (["install", "exec", "build", "add", "audit"].includes(name)) { if (name === "build") ran.add("build"); continue; }
        ran.add(name);
        if (!scripts[name]) problems.push(`${jobName}: «pnpm ${name}» is not a script in package.json`);
      }
      for (const match of line.matchAll(/node (?:--import tsx )?(phase1-backend\/tests\/[a-z0-9._-]+\.mjs)/g)) {
        ran.add(match[1]);
        if (!existsSync(match[1])) problems.push(`${jobName}: ${match[1]} does not exist`);
      }
    }
  }
}
// Every marketplace suite is run somewhere: its script (integration) or its file (browser).
for (const file of readdirSync("phase1-backend/tests").filter((name) => /^market-.*\.(integration|browser-acceptance)\.mjs$/.test(name))) {
  const path = `phase1-backend/tests/${file}`;
  const viaScript = Object.entries(scripts).some(([name, command]) => ran.has(name) && command.includes(path));
  if (!ran.has(path) && !viaScript) problems.push(`${path} is not run by any CI step`);
}
assert.deepEqual(problems, [], `CI workflow problems:\n  ${problems.join("\n  ")}`);
console.log(JSON.stringify({ suite: "ci-workflow-guard", status: "passed", jobs: Object.keys(workflow.jobs), steps: Object.values(workflow.jobs).reduce((sum, job) => sum + job.steps.length, 0) }));
