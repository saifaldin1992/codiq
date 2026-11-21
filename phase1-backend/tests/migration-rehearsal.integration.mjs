/**
 * ق-247 — the migration rehearsal: every unreleased migration replayed over
 * production-shaped rows before it is allowed near production.
 *
 * WHY. CI migrates an EMPTY database and calls that proof. It is not: a
 * migration that rewrites rows, or adds a CHECK over rows that already exist,
 * meets its first real data in staging — or in production. On 2026-09-14 the
 * ق-209 migration lowered every payment-method code while phase 1's CHECK
 * still insisted an enabled row is spelled 'COD'; CI was green because CI has
 * no rows, staging failed with 23514 at 13:18 UTC and stayed pinned to an
 * older build for seven hours, and production — which holds the same two
 * bootstrap rows per store — would have failed identically at release.
 *
 * WHAT. `prisma/migrations/RELEASED` names the last migration production has
 * applied (the release procedure advances it). This suite builds a throwaway
 * database, migrates it exactly that far with Prisma itself, inserts the rows
 * in `fixtures/migration-rehearsal-seed.sql` — the shapes production actually
 * holds — and then runs `prisma migrate deploy` with the full folder. A
 * migration that cannot cross real rows fails HERE, on the pull request that
 * introduces it, with Prisma's own error.
 *
 * The seed is deliberately small and deliberately literal — production's rows
 * as they are at RELEASED: one enabled 'cod' payment row (its day-one version
 * carried phase 1's upper-case 'COD' beside a dead 'CARD', which is exactly
 * what caught ق-209), an order paid 'cod', a store-less password-reset mail, a
 * platform audit row. Each is a shape some past migration would have tripped
 * on had it been wrong. Add a row whenever a migration is about to rewrite or
 * constrain a table this file does not seed, and move the rows forward with
 * the marker whenever a released migration changes their shape.
 *
 * Run: pnpm migrate:rehearsal   (needs CODIQ_TEST_DATABASE_URL; creates and
 * drops `codiq_ci_rehearsal_test` beside it — never touches the CI database.)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const RELEASED_MARKER = path.join(MIGRATIONS, "RELEASED");
const SEED = path.join(HERE, "fixtures", "migration-rehearsal-seed.sql");
const REHEARSAL_DB = "codiq_ci_rehearsal_test";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const baseUrl = assertSafeTestDatabaseUrl(
  process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL
);

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
const adminUrl = withDatabase(baseUrl, "postgres");
const rehearsalUrl = withDatabase(baseUrl, REHEARSAL_DB);

function migrateDeploy(schemaPath) {
  // The same invocation `scripts/migrate-deploy.ts` makes, against the rehearsal database.
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "migrate", "deploy", "--schema", schemaPath],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: rehearsalUrl },
      encoding: "utf8",
      shell: process.platform === "win32",
    }
  );
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const folders = readdirSync(MIGRATIONS)
  .filter((entry) => statSync(path.join(MIGRATIONS, entry)).isDirectory())
  .sort();
assert.ok(
  existsSync(RELEASED_MARKER),
  "prisma/migrations/RELEASED must name the last migration production has applied"
);
const released = readFileSync(RELEASED_MARKER, "utf8").trim();
assert.ok(
  folders.includes(released),
  `prisma/migrations/RELEASED names «${released}», which is not a migration folder`
);
const baseline = folders.filter((entry) => entry <= released);
const unreleased = folders.filter((entry) => entry > released);

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${REHEARSAL_DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${REHEARSAL_DB}`);

const stage = mkdtempSync(path.join(tmpdir(), "codiq-rehearsal-"));
const summary = {
  suite: "migration-rehearsal",
  released,
  baselineMigrations: baseline.length,
  rehearsed: unreleased.length,
};
try {
  // 1. Production's schema, as Prisma itself would build it: the folder cut at RELEASED.
  const stagedMigrations = path.join(stage, "prisma", "migrations");
  mkdirSync(stagedMigrations, { recursive: true });
  cpSync(SCHEMA, path.join(stage, "prisma", "schema.prisma"));
  for (const entry of baseline)
    cpSync(path.join(MIGRATIONS, entry), path.join(stagedMigrations, entry), { recursive: true });
  const toBaseline = migrateDeploy(path.join(stage, "prisma", "schema.prisma"));
  assert.equal(
    toBaseline.code,
    0,
    `the released migrations must apply cleanly to an empty database:\n${toBaseline.output.slice(-2000)}`
  );

  // 2. The rows production holds.
  const db = new Client({ connectionString: rehearsalUrl });
  await db.connect();
  try {
    await db.query(readFileSync(SEED, "utf8"));
    const {
      rows: [{ n }],
    } = await db.query(
      `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`
    );
    assert.equal(
      n,
      baseline.length,
      "every released migration is recorded as applied before the seed"
    );
  } finally {
    await db.end();
  }

  // 3. The unreleased migrations, over those rows — the deploy production will run.
  const onward = migrateDeploy(SCHEMA);
  if (onward.code !== 0) {
    const failed =
      onward.output.match(/Migration name: (\S+)/)?.[1] ??
      onward.output.match(/The `([^`]+)` migration/)?.[1] ??
      "(see output)";
    assert.fail(
      `unreleased migration «${failed}» does not survive production-shaped rows — it would fail the release exactly like this:\n` +
        onward.output.slice(-2500)
    );
  }

  // 4. What the rehearsal must leave behind: the seed transformed, nothing lost.
  const after = new Client({ connectionString: rehearsalUrl });
  await after.connect();
  try {
    const { rows: applied } = await after.query(
      `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`
    );
    assert.equal(
      applied[0].n,
      folders.length,
      "every migration in the folder is applied after the rehearsal"
    );
    const { rows: methods } = await after.query(
      `SELECT code, is_enabled FROM payment_methods ORDER BY code`
    );
    assert.deepEqual(
      methods,
      [{ code: "cod", is_enabled: true }],
      "the store keeps exactly one enabled 'cod' payment row across every replayed migration"
    );
    const { rows: orders } = await after.query(
      `SELECT count(*)::int AS n FROM store_orders WHERE payment_method_code = 'cod'`
    );
    assert.equal(orders[0].n, 1, "the seeded order is still there, still 'cod'");
    summary.paymentMethodsAfter = methods;
  } finally {
    await after.end();
  }
  summary.status = "passed";
  console.log(JSON.stringify(summary, null, 2));
} finally {
  rmSync(stage, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS ${REHEARSAL_DB} WITH (FORCE)`);
  await admin.end();
}
