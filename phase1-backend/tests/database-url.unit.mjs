/**
 * ق-155 — migrations must reach a DIRECT connection, whatever the variable is
 * called.
 *
 * WHAT THIS EXISTS TO PREVENT, measured. On 2026-09-06 the staging service
 * failed to deploy four times inside an hour:
 *
 *   Error: P1002 — Timed out trying to acquire a postgres advisory lock
 *   (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.
 *
 * Prisma's own preceding line named the cause: it had connected to
 * `ep-red-mode-b1tc5e9d-pooler.c-5.eu-central-1.aws.neon.tech`. Staging's
 * `CODIQ_POSTGRES_URL_UNPOOLED` contained a POOLED url — a variable whose name
 * described what somebody intended rather than what it held. Production's was
 * correct, which is why the identical code deployed cleanly there for weeks.
 *
 * `migrate deploy` takes a SESSION-level advisory lock so two deploys cannot
 * migrate at once. A transaction pooler hands each statement to whatever
 * backend is free, so the lock is taken on one connection and sought on
 * another. The migration blocks on itself. And it is INTERMITTENT — a quiet
 * pooler often reuses one backend and the deploy passes — which is precisely
 * how the misconfiguration survived every review it ever had.
 *
 * Run: pnpm db:url:test
 */
import assert from "node:assert/strict";
import {
  databaseHost,
  resolveCodiqMigrationDatabaseUrl,
  withoutNeonPooler,
} from "../src/db/database-url.ts";

const POOLED =
  "postgresql://user:secret@ep-red-mode-b1tc5e9d-pooler.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const DIRECT =
  "postgresql://user:secret@ep-red-mode-b1tc5e9d.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require";

// 1. The rewrite itself: host only, everything else byte-for-byte.
const corrected = withoutNeonPooler(POOLED);
assert.equal(
  databaseHost(corrected),
  "ep-red-mode-b1tc5e9d.c-5.eu-central-1.aws.neon.tech",
  "the -pooler suffix is removed from the HOST"
);
assert.ok(corrected.includes("user:secret@"), "credentials survive untouched");
assert.ok(corrected.includes("sslmode=require"), "query parameters survive untouched");
assert.ok(!corrected.includes("-pooler"), "…and no trace of the pooler remains");

// 2. An already-direct url is returned unchanged. A rewrite that fires on the
//    correct case is a rewrite that will eventually corrupt one.
assert.equal(withoutNeonPooler(DIRECT), DIRECT, "a direct url passes through identically");

// 3. Nothing outside Neon is touched. `-pooler.` is Neon's convention, not a
//    universal one, and guessing at another vendor's hostname breaks it.
const OTHER = "postgresql://u:p@db.internal.example.com:5432/app";
assert.equal(withoutNeonPooler(OTHER), OTHER, "a non-Neon host is left alone");
const LOCAL = "postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public";
assert.equal(withoutNeonPooler(LOCAL), LOCAL, "localhost is left alone — this runs in CI too");

// 4. A string that will not parse must NOT be rewritten. Silently mangling an
//    unrecognised connection string is worse than passing it through.
assert.equal(
  withoutNeonPooler("not a url at all"),
  "not a url at all",
  "an unparseable value is returned as given"
);
assert.equal(
  databaseHost("not a url at all"),
  "unparseable",
  "…and reports itself honestly rather than throwing mid-deploy"
);

// 5. THE ASSERTION THAT EARNS ITS PLACE: the resolver used by the migration
//    command corrects a mislabelled variable rather than trusting its name.
//    This is the exact staging state, reproduced.
const staging = {
  CODIQ_POSTGRES_URL_UNPOOLED: POOLED,
  CODIQ_POSTGRES_URL: POOLED,
  DATABASE_URL: POOLED,
};
assert.ok(
  !resolveCodiqMigrationDatabaseUrl(staging).includes("-pooler"),
  "a variable NAMED unpooled that holds a pooled url must not reach `prisma migrate deploy`"
);

// …and the ordinary case still prefers the explicitly configured direct url.
assert.equal(
  resolveCodiqMigrationDatabaseUrl({
    CODIQ_POSTGRES_URL_UNPOOLED: DIRECT,
    CODIQ_POSTGRES_URL: POOLED,
  }),
  DIRECT,
  "the dedicated variable is still preferred when it is correct"
);

// …and with no dedicated variable at all it falls back and still corrects.
assert.ok(
  !resolveCodiqMigrationDatabaseUrl({ CODIQ_POSTGRES_URL: POOLED }).includes("-pooler"),
  "the fallback path is corrected too — an environment with only one variable is the common case"
);

console.log(
  JSON.stringify(
    {
      suite: "database-url",
      status: "passed",
      summary: {
        rewrites: "neon -pooler hosts only",
        untouched: ["already-direct", "non-neon", "localhost", "unparseable"],
        guarantees: "prisma migrate deploy never receives a transaction-pooled connection",
      },
    },
    null,
    2
  )
);
