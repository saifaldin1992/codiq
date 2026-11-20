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
import { databaseHost, resolveCodiqMigrationDatabaseUrl } from "../src/db/database-url.js";

const requested = process.env.CODIQ_POSTGRES_URL_UNPOOLED ?? process.env.CODIQ_POSTGRES_URL ?? process.env.DATABASE_URL ?? "";
const resolved = resolveCodiqMigrationDatabaseUrl();
const before = databaseHost(requested);
const after = databaseHost(resolved);

if (before !== after) {
  console.log(
    `[migrate] the configured connection was POOLED (${before}); migrations will use ${after} instead.\n` +
      `[migrate] prisma takes a session-level advisory lock, and a transaction pooler does not keep a migration on one backend — ` +
      `that is the P1002 timeout. Fix the variable at its source when convenient; this rewrite is a floor, not a substitute.`,
  );
} else {
  console.log(`[migrate] direct connection: ${after}`);
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
  // Node 20.12+ refuses to start a `.cmd` without a shell (CVE-2024-27980),
  // which is what `npx.cmd` is on Windows. The arguments are fixed strings,
  // so the shell adds no surface here — it only lets the owner run this on
  // his own machine.
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: resolved }, shell: process.platform === "win32" },
);
child.on("close", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`[migrate] could not start prisma: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
