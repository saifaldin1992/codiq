/**
 * ق-189 — a document that states a countable fact must state the true one.
 *
 * ============================================================================
 * WHY THIS GUARD AND NOT A ROUND OF EDITS
 * ============================================================================
 *
 * A four-reader survey of the documentation on 2026-09-09 found the same defect
 * this phase has been chasing in the CODE, now in prose: files that reassure
 * without being true. The worst of them was not obscure — `OPERATING_GUIDE.md`
 * opened by telling every new developer to read `HANDOFF.md` FIRST, and
 * `HANDOFF.md` described the deploy model BACKWARDS (it said production was
 * deliberately stale and upgraded by hand; production has tracked the `release`
 * branch since ق-134). A newcomer's first and most trusted page was its most
 * wrong one.
 *
 * Editing the numbers would fix today and nothing else. Every count in this
 * repository drifts within days — the ledger gains rows, migrations land, a
 * suite is added — and the documents that quote them were all correct when
 * written. `PROJECT_STATE.md` even carries a rule at its head forbidding
 * uncounted claims, and had drifted anyway: it said «آخرها ق-158» while the
 * ledger stood at ق-188, and «٥٩ هجرة» against 66 on disk.
 *
 * So the countable claims become CI's problem. A number in prose that CI can
 * verify is no longer documentation; it is an assertion, and it fails the build
 * when it rots. Claims this cannot check — judgement, rationale, history — stay
 * the writer's responsibility, and this guard deliberately says nothing about
 * them rather than pretending to.
 *
 * TO ADD A CLAIM: write it in a document in the shape `<label>: <number>`-ish,
 * add a row below with the regex that finds it and the function that counts the
 * truth, and watch it fail before you fix the document.
 *
 * Run: pnpm docs:fresh
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const dirsIn = (relative) =>
  readdirSync(path.join(root, relative), { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  ).length;
const filesMatching = (relative, suffix) =>
  readdirSync(path.join(root, relative)).filter((name) => name.endsWith(suffix)).length;

/** Arabic-Indic digits appear in the prose; both forms must read as the number. */
const toWestern = (text) => text.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));

const ci = read(".github/workflows/ci.yml");
const ledger = read("docs/DECISIONS_LEDGER.md");

const TRUTH = {
  latestDecision: Math.max(
    ...[...ledger.matchAll(/^\| ق-(\d+)/gm)].map((match) => Number(match[1]))
  ),
  migrations: dirsIn("prisma/migrations"),
  models: (read("prisma/schema.prisma").match(/^model /gm) ?? []).length,
  guards: filesMatching("phase1-backend/tests", ".guard.mjs"),
  browserSuites: filesMatching("phase1-backend/tests", ".browser-acceptance.mjs"),
};

/**
 * Each row: where the claim lives, what finds it, and what it must equal.
 * `label` is what the failure message says, in the words of the document.
 */
const CLAIMS = [
  {
    file: "docs/PROJECT_STATE.md",
    label: "آخر قرار في السجلّ",
    pattern: /آخرها\s*\*{0,2}ق-(\d+)/,
    truth: () => TRUTH.latestDecision,
  },
  // Bold-anchored ON PURPOSE. The document opens by QUOTING the old file's
  // lies as examples («١٧ هجرة» بينما العدد ٥٨) — a loose /(\d+) هجرة/ matches
  // the quoted lie and reports it as the document's own claim. A guard that
  // reads a quotation as an assertion is a guard that cries wolf until muted.
  {
    file: "docs/PROJECT_STATE.md",
    label: "عدد الهجرات",
    pattern: /\*\*(\d+)\s*هجرة\*\*/,
    truth: () => TRUTH.migrations,
  },
  {
    file: "docs/OPERATING_GUIDE.md",
    label: "مدى أرقام السجلّ",
    pattern: /ق-01\s*…\s*ق-(\d+)/,
    truth: () => TRUTH.latestDecision,
  },
];

const failures = [];
for (const claim of CLAIMS) {
  const source = toWestern(read(claim.file));
  const found = source.match(claim.pattern);
  if (!found) {
    failures.push(
      `${claim.file}: the claim «${claim.label}» is gone. Either it was removed on purpose — then remove its row from CLAIMS — or the wording changed and this guard is now watching nothing.`
    );
    continue;
  }
  const stated = Number(found[1]);
  const actual = claim.truth();
  if (stated !== actual) {
    failures.push(`${claim.file}: «${claim.label}» says ${stated}, the repository says ${actual}.`);
  }
}

/**
 * Two claims that are not numbers but that MOVED PEOPLE'S BEHAVIOUR when wrong.
 *
 * The browser job carried `continue-on-error: true` until 2026-09-04. Three
 * documents still described it as non-blocking afterwards, and a developer who
 * believed them skipped the browser suites before pushing — which is how a real
 * regression reaches a real merchant. The only job that may carry that flag is
 * the staging probe, which is a probe of someone else's environment.
 */
const browserJob = ci.slice(ci.indexOf("browser-acceptance:"));
if (
  /continue-on-error:\s*true/.test(
    browserJob.slice(0, browserJob.indexOf("\n  ", 1) + 1 || undefined)
  )
) {
  failures.push(
    "ci.yml: the browser-acceptance job carries continue-on-error again. It became blocking on 2026-09-04 after eleven runs on main; making it advisory again is a decision that needs a ledger row, not a flag."
  );
}
for (const file of [
  "docs/DEPLOYMENT.md",
  "docs/DEVELOPMENT_ENVIRONMENT.md",
  "docs/PROJECT_STATE.md",
]) {
  const source = read(file);
  if (/continue-on-error/.test(source) && /(غير حاجبة|غير حاجب|non-blocking)/.test(source)) {
    failures.push(
      `${file}: still describes the browser job as non-blocking. It has been blocking since 2026-09-04 (ci.yml), and a developer who believes this skips the browser suites before pushing.`
    );
  }
}

/**
 * The entry point. `OPERATING_GUIDE.md` is what a newcomer is handed, and its
 * first instruction decides which document he trusts. It pointed at HANDOFF.md,
 * which was wrong about the deploy model in the direction that causes damage.
 */
// The assertion is POSITIVE — the opening must NAME the current-state document.
// A negative check («must not mention HANDOFF.md») was written first and was
// wrong: it fired on the honest one-line warning that HANDOFF is a dated
// snapshot, which is exactly the sentence a reader needs. Forbidding a word is
// not the same as requiring the right instruction.
const guide = read("docs/OPERATING_GUIDE.md");
const firstRead = guide.slice(0, guide.indexOf("\n---") + 1 || 2000);
if (!/اقرأ[^\n]*PROJECT_STATE\.md[^\n]*أولاً/.test(firstRead)) {
  failures.push(
    "docs/OPERATING_GUIDE.md: its opening no longer tells the reader to start at PROJECT_STATE.md. Whatever it points at first is the document every newcomer will trust; it must be the one that carries the operational state and forbids uncounted claims."
  );
}

/**
 * The guard roster documents itself, or it becomes the next stale page.
 *
 * `GUARDS_AND_RATCHETS.md` exists because the strongest idea in this repository
 * was implemented everywhere and written down nowhere. A roster that lists 31
 * guards is exactly the kind of claim that is true the day it is written and
 * quietly false a week later — so the roster is checked the way every other
 * count here is: every guard file must appear in it, and every `pnpm` command
 * it names must exist.
 */
const roster = read("docs/GUARDS_AND_RATCHETS.md");
const scripts = JSON.parse(read("package.json")).scripts ?? {};
const guardFiles = readdirSync(path.join(root, "phase1-backend/tests")).filter((name) =>
  name.endsWith(".guard.mjs")
);
const unlisted = guardFiles
  .map((name) => name.replace(".guard.mjs", ""))
  .filter((name) => !roster.includes(name));
if (unlisted.length) {
  failures.push(
    `docs/GUARDS_AND_RATCHETS.md: ${unlisted.length} guard(s) exist and are not in the roster — ${unlisted.join(", ")}. A roster that omits a guard teaches the next reader that the rule does not exist.`
  );
}
const namedCommands = [...roster.matchAll(/`pnpm ([a-z0-9:.-]+)`/g)].map((match) => match[1]);
const unknownCommands = [...new Set(namedCommands)].filter((command) => !(command in scripts));
if (unknownCommands.length) {
  failures.push(
    `docs/GUARDS_AND_RATCHETS.md: names command(s) package.json does not have — ${unknownCommands.join(", ")}. A reader who copies one gets an error and stops trusting the page.`
  );
}

assert.deepEqual(
  failures,
  [],
  `documentation states things the repository contradicts:\n${failures.map((line) => `  · ${line}`).join("\n")}\n` +
    `  A number in prose that CI can check is an assertion, not decoration. Fix the document, or remove the claim.`
);

console.log(
  JSON.stringify(
    {
      suite: "docs-freshness",
      status: "passed",
      summary: {
        truth: TRUTH,
        claimsChecked: CLAIMS.length,
        behaviourChecks: [
          "browser job is blocking",
          "no document calls it advisory",
          "the guide's first read is the current-state document",
        ],
        guarantee:
          "every countable claim this guard knows about matches the repository it describes",
      },
    },
    null,
    2
  )
);
