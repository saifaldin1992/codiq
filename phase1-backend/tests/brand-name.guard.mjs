/**
 * ق-161 — the brand is written **Codiq**, and only the first letter is capital.
 *
 * The owner asked for it in one sentence: «اريد فقط اول حرف كابتل و ليس كل
 * الكلمة كابتل». A name is not a detail — it is the first thing every merchant,
 * every shopper and every recipient of a password-reset email reads.
 *
 * ============================================================================
 * WHY THIS IS A GUARD AND NOT A ONE-TIME EDIT
 * ============================================================================
 *
 * A rename decays. The next screen, the next email subject, the next page title
 * gets typed as `CODIQ` by habit — and nobody notices, because a brand written
 * two ways looks like two products only to someone reading carefully. So the
 * shape is enforced rather than announced.
 *
 * ============================================================================
 * WHAT IT MUST NOT TOUCH — and why a blind rename would have been an outage
 * ============================================================================
 *
 *   CODIQ_ENCRYPTION_KEY, CODIQ_SMTP_*, CODIQ_RESEND_API_KEY …
 *       environment variable NAMES. Renaming one is an outage on the next
 *       deploy, with a message that names a variable nobody set.
 *   CODIQBK1
 *       the eight magic bytes at the head of every backup file ever written.
 *       Rewriting that string does not break a test — it makes every stored
 *       backup unreadable, and the discovery happens during a restore.
 *   --codiq-*, codiq-phase1, codiq_session
 *       CSS custom properties, the package name, the session cookie.
 *
 * All of those survive because the pattern requires a WORD BOUNDARY on both
 * sides and refuses a following `_` or `-`. `CODIQBK1` has no boundary after
 * `CODIQ`; `CODIQ_SMTP_HOST` is excluded by the lookahead.
 *
 * Comments are skipped: they are not read by anyone the brand is for, and
 * policing them would bury a real regression in prose.
 *
 * Run: pnpm brand:guard
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ROOTS = ["client/src", "phase1-backend/src"].map((p) => path.join(repoRoot, p));
const SINGLE_FILES = [path.join(repoRoot, "client/index.html")];

/**
 * Generated from the routing table and rewritten by `pnpm openapi:generate`;
 * policing a mirror reports the reflection instead of the thing.
 */
const GENERATED = path.join("http", "openapi.document.ts");

const isComment = (line) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line);
const SHOUTED = /\bCODIQ\b(?![_-])/;

function sources(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sources(full));
    else if (/\.(tsx|ts|html)$/.test(entry)) found.push(full);
  }
  return found;
}

const files = [...ROOTS.flatMap(sources), ...SINGLE_FILES].filter(
  (file) => !file.endsWith(GENERATED)
);

const violations = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (isComment(line) || !SHOUTED.test(line)) return;
      violations.push({
        file: path.relative(repoRoot, file).replace(/\\/g, "/"),
        line: index + 1,
        text: line.trim().slice(0, 120),
      });
    });
}

if (violations.length) {
  console.error(
    `ق-161: ${violations.length} place(s) still shout the brand. It is written «Codiq» — one capital.\n` +
      violations.map((v) => `  ${v.file}:${v.line}\n      ${v.text}`).join("\n") +
      `\n\nIf one of these is an identifier rather than the brand — an env var, a file magic, a cookie — ` +
      `it must not match this pattern at all; say so by making it one (CODIQ_…) rather than by exempting it here.`
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        suite: "brand-name",
        status: "passed",
        summary: {
          scanned: files.length,
          shoutedBrand: 0,
          protected: [
            "CODIQ_* environment names",
            "CODIQBK1 backup magic",
            "--codiq-* tokens",
            "codiq_session",
          ],
        },
      },
      null,
      2
    )
  );
}
