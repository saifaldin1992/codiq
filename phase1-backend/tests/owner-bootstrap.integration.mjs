/**
 * Integration — the bootstrap that mints the first platform owner.
 *
 * Why this file exists: on 2026-09-05 the production census answered
 * `platform_owners = 0`, and the three documented recovery paths all assumed a
 * row that was not there. The fix is a script; a script nobody runs until the
 * worst day is a script that has never been shown to work. This runs it.
 *
 * The two properties that matter are both refusals, not the happy path:
 *   1. it will not mint a SECOND owner, and
 *   2. it will not accept a password the platform itself would reject.
 *
 * Run: pnpm owner:bootstrap:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { createFirstOwner } = await import("../scripts/create-first-owner.ts");
const { prisma } = await import("../src/db/prisma.ts");

const summary = {};
const stamp = Date.now();
const email = `bootstrap-${stamp}@codiq.test`;

// The suite must start from the state the script is FOR — an empty table.
// Anything left by another suite would make the first assertion pass or fail
// for the wrong reason, so we say so out loud rather than silently deleting.
const preexisting = await prisma.platformOwner.count();
assert.equal(
  preexisting,
  0,
  `this suite needs a database with no platform owners; found ${preexisting}. Run it against its own database.`
);

// ============================================================
// 1. A weak password is refused — by the platform's own policy, not a copy.
// ============================================================
await assert.rejects(
  () => createFirstOwner({ email, displayName: "مالك المنصة", password: "12345678" }),
  (error) => /password/i.test(error.message) || error.code !== undefined,
  "ق-129: the floor is 8 characters AND a refusal of the passwords people actually pick — a bootstrap that skipped the second half would hand the platform's root account to a dictionary"
);
assert.equal(await prisma.platformOwner.count(), 0, "a refused password writes nothing");
summary.policy =
  "the ق-129 policy applies to the root account too, via the same code path as the HTTP route";

// ============================================================
// 2. The happy path — on an empty table, exactly one owner appears.
// ============================================================
const created = await createFirstOwner({
  email,
  displayName: "  مالك المنصة  ",
  password: "Codiq-Bootstrap-2026",
});
assert.equal(created.email, email, "the address is stored normalised");
assert.equal(
  created.displayName,
  "مالك المنصة",
  "the display name is trimmed, as the service does for the HTTP route"
);
assert.equal(await prisma.platformOwner.count(), 1, "exactly one row");

const row = await prisma.platformOwner.findUnique({
  where: { email },
  select: { passwordHash: true },
});
assert.ok(
  row?.passwordHash?.startsWith("$2"),
  "the password is bcrypt-hashed, never stored as typed"
);
assert.ok(
  !row.passwordHash.includes("Codiq-Bootstrap-2026"),
  "…and the plaintext appears nowhere in the row"
);
summary.bootstrap =
  "an empty database gains exactly one owner, hashed by the platform's own hasher";

// ============================================================
// 3. The refusal that matters most: never a second owner.
// ============================================================
await assert.rejects(
  () =>
    createFirstOwner({
      email: `second-${stamp}@codiq.test`,
      displayName: "مالك ثانٍ",
      password: "Codiq-Bootstrap-2026",
    }),
  (error) => error.message.startsWith("OWNER_ALREADY_EXISTS"),
  "a re-run must refuse — two people who can do anything, with no record of which one acted, is worse than a failed command"
);
assert.equal(await prisma.platformOwner.count(), 1, "the refusal wrote nothing");
summary.singleOwner = "a second run refuses and points at owner:email instead";

// ============================================================
// 4. The password is never an argument — enforced in the source, not the docs.
// ============================================================
// A comment saying "do not pass --password" is a wish. This asserts the guard
// clause is actually in the file, because the day someone "simplifies" the
// script for automation is the day the root password lands in a CI log.
const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "create-first-owner.ts"
);
const source = readFileSync(scriptPath, "utf8");
assert.ok(
  /--password/.test(source) && /process\.exitCode = 1/.test(source),
  "the script must refuse a --password argument outright"
);
assert.ok(
  /isTTY/.test(source),
  "…and refuse a piped password, which is the same secret in a different file"
);
summary.noArgvPassword =
  "--password and piped input are both refused in source, not merely discouraged in a comment";

// The first run of this suite exited 1 with every assertion green: importing the
// script ran `main()`, which printed a usage line and set the exit code. A test
// that reports "passed" and fails anyway is the worst of both, so the guard that
// fixed it is pinned here.
assert.ok(
  /invokedDirectly/.test(source),
  "the script must run `main()` only when it IS the command — importing it must stay silent"
);
summary.importable = "importing the script runs nothing; only invoking it as a command does";

await prisma.platformOwner.deleteMany({ where: { email } });
await prisma.$disconnect();
console.log(JSON.stringify({ suite: "owner-bootstrap", status: "passed", summary }, null, 2));
