const DEVELOPMENT_HOST = "ep-bold-band-b1gy3zvi-pooler.c-5.eu-central-1.aws.neon.tech";
const TEST_MARKER = /development|test|phase/i;

export function assertSafeTestDatabaseUrl(
  databaseUrl: string | undefined,
  productionDatabaseUrl: string | undefined = process.env.CODIQ_PRODUCTION_DATABASE_URL ?? process.env.CODIQ_POSTGRES_URL,
): string {
  if (!databaseUrl) {
    throw new Error("Refusing database access: CODIQ_TEST_DATABASE_URL is required for isolated integration tests.");
  }

  let testUrl: URL;
  try {
    testUrl = new URL(databaseUrl);
  } catch {
    throw new Error("Refusing database access: CODIQ_TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!testUrl.protocol.startsWith("postgres")) {
    throw new Error("Refusing database access: CODIQ_TEST_DATABASE_URL must use PostgreSQL.");
  }

  if (productionDatabaseUrl) {
    const productionHost = new URL(productionDatabaseUrl).hostname;
    if (testUrl.hostname === productionHost) {
      throw new Error("Refusing database access: the requested test host matches the configured production host.");
    }
  }

  const isApprovedDevelopmentHost = testUrl.hostname === DEVELOPMENT_HOST;
  if (!isApprovedDevelopmentHost && !TEST_MARKER.test(databaseUrl)) {
    throw new Error("Refusing database access: CODIQ_TEST_DATABASE_URL must contain development, test, or phase, or use the approved Neon development host.");
  }

  return databaseUrl;
}
