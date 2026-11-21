/**
 * ق-155 — the one door migrations go through.
 *
 * `phase1:db:migrate` used to be a shell one-liner that picked a variable by
 * name and hoped:
 *
 *   sh -c 'DATABASE_URL="${CODIQ_POSTGRES_URL_UNPOOLED:-…}" prisma migrate deploy'
 *
 * That is how staging spent an hour failing to deploy with P1002 while
 * production, whose variable happened to be right, sailed through. A shell
 * expansion cannot check that a value named «unpooled» is unpooled, and it
 * cannot say which host it ended up on — so nobody could see the difference
 * between the two environments without reading Prisma's incidental log line.
 *
 * This script resolves the url through `resolveCodiqMigrationDatabaseUrl`,
 * which now GUARANTEES a direct connection, and prints the host it will use —
 * host only, never the credential. One line in the deploy log that answers
 * «which database, pooled or not?» before the migration runs, instead of after
 * it fails.
 *
 * Run: pnpm phase1:db:migrate
 */
import { spawn } from "node:child_process";
import pg from "pg";
import { databaseHost, resolveCodiqMigrationDatabaseUrl } from "../src/db/database-url.js";

const requested =
  process.env.CODIQ_POSTGRES_URL_UNPOOLED ??
  process.env.CODIQ_POSTGRES_URL ??
  process.env.DATABASE_URL ??
  "";
const resolved = resolveCodiqMigrationDatabaseUrl();
const before = databaseHost(requested);
const after = databaseHost(resolved);

if (before !== after) {
  console.log(
    `[migrate] the configured connection was POOLED (${before}); migrations will use ${after} instead.\n` +
      `[migrate] prisma takes a session-level advisory lock, and a transaction pooler does not keep a migration on one backend — ` +
      `that is the P1002 timeout. Fix the variable at its source when convenient; this rewrite is a floor, not a substitute.`
  );
} else {
  console.log(`[migrate] direct connection: ${after}`);
}

/**
 * SUPABASE PREFLIGHT — an extension in another schema, behind a pinned search_path.
 *
 * Supabase installs extensions enabled from its dashboard into a schema named
 * `extensions`, which its roles keep on their default search_path. A Prisma url
 * carrying `?schema=public` REPLACES that search_path with `public` alone, and
 * the search-index migration then dies half-way with
 * `operator class "gin_trgm_ops" does not exist`. Measured 2026-11-20 against a
 * database shaped exactly like that: the same url without `schema` migrates and
 * every search suite passes.
 *
 * So the condition is checked BEFORE prisma runs, and the message names the fix.
 */
const EXTENSIONS_WE_USE = ["pg_trgm", "btree_gist"];
async function preflightExtensionSchemas(url: string) {
  const parsed = new URL(url);
  const pinned = parsed.searchParams.get("schema");
  if (!pinned) return;
  for (const key of [
    "schema",
    "pgbouncer",
    "connection_limit",
    "pool_timeout",
    "connect_timeout",
    "statement_cache_size",
  ])
    parsed.searchParams.delete(key);
  const client = new pg.Client({ connectionString: parsed.toString() });
  try {
    await client.connect();
    const { rows } = await client.query<{ extname: string; schema: string }>(
      "SELECT e.extname, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ANY($1)",
      [EXTENSIONS_WE_USE]
    );
    const elsewhere = rows.filter((row) => row.schema !== pinned);
    if (elsewhere.length) {
      console.error(
        `[migrate] ${elsewhere.map((row) => `${row.extname} is installed in schema "${row.schema}"`).join(", ")}, ` +
          `but the url pins search_path to "${pinned}" (?schema=${pinned}), so its operators are invisible to the migrations.\n` +
          `[migrate] Fix: remove "schema=${pinned}" from the database url (Supabase keeps "extensions" on the role's search_path), ` +
          `or move the extension: ALTER EXTENSION <name> SET SCHEMA ${pinned};`
      );
      process.exit(1);
    }
  } catch (error) {
    // A preflight that cannot connect must not mask prisma's own, better, connection error.
    console.warn(
      `[migrate] extension preflight skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
await preflightExtensionSchemas(resolved);

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
  // Node 20.12+ refuses to start a `.cmd` without a shell (CVE-2024-27980),
  // which is what `npx.cmd` is on Windows. The arguments are fixed strings,
  // so the shell adds no surface here — it only lets the owner run this on
  // his own machine.
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: resolved },
    shell: process.platform === "win32",
  }
);
child.on("close", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(
    `[migrate] could not start prisma: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
