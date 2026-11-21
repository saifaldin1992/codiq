export type DatabaseEnvironment = Record<string, string | undefined>;

export function resolveCodiqDatabaseUrl(environment: DatabaseEnvironment = process.env): string {
  const url = environment.CODIQ_POSTGRES_URL ?? environment.DATABASE_URL;
  if (!url)
    throw new Error(
      "Missing required PostgreSQL connection string: CODIQ_POSTGRES_URL or DATABASE_URL"
    );
  if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    throw new Error("Codiq requires a standard PostgreSQL connection string");
  }
  return url;
}

/**
 * ق-155 — migrations get a DIRECT connection, guaranteed rather than requested.
 *
 * This used to read `CODIQ_POSTGRES_URL_UNPOOLED ?? …` and stop there: it
 * trusted the NAME of a variable to describe its VALUE. On 2026-09-06 the
 * staging deployment failed four times in an hour with
 *
 *   Error: P1002 — Timed out trying to acquire a postgres advisory lock
 *   (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.
 *
 * and Prisma's own line named the reason: it was connected to
 * `ep-red-mode-…-pooler.…neon.tech`. Staging's `CODIQ_POSTGRES_URL_UNPOOLED`
 * held a POOLED url. Production's did not — which is why the same code shipped
 * for weeks and only one environment ever broke.
 *
 * WHY IT MATTERS BEYOND A TYPO. `prisma migrate deploy` takes a SESSION-level
 * advisory lock so two deploys cannot migrate at once. PgBouncer in transaction
 * mode hands each statement whatever backend is free, so the lock is taken on
 * one connection and looked for on another — the migration then blocks on
 * itself and times out. And it is INTERMITTENT: a quiet pooler often keeps the
 * same backend and the deploy passes, which is exactly how a broken
 * configuration survives review.
 *
 * Neon's convention is that the direct host is the pooled host minus the
 * `-pooler` suffix, so the correction is mechanical and needs no new secret.
 * Anything that is not a Neon pooled host passes through untouched.
 */
export function resolveCodiqMigrationDatabaseUrl(
  environment: DatabaseEnvironment = process.env
): string {
  const candidate = environment.CODIQ_POSTGRES_URL_UNPOOLED ?? resolveCodiqDatabaseUrl(environment);
  return withoutNeonPooler(candidate);
}

/** `ep-x-pooler.eu.aws.neon.tech` → `ep-x.eu.aws.neon.tech`. Everything else is returned as given. */
export function withoutNeonPooler(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    // A string this file cannot parse is a string it must not silently rewrite.
    return connectionString;
  }
  if (!parsed.hostname.includes("-pooler.")) return connectionString;
  parsed.hostname = parsed.hostname.replace("-pooler.", ".");
  return parsed.toString();
}

/** The host only — safe to print. Used by the migrate script's one log line. */
export function databaseHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return "unparseable";
  }
}
