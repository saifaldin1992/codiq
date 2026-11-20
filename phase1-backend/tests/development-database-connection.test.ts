import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

describe("development database connection guard", () => {
  it("accepts the approved development URL and only then executes a lightweight query", async () => {
    const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const result = await prisma.$queryRawUnsafe<Array<{ database_name: string }>>("SELECT current_database() AS database_name");
      expect(result).toHaveLength(1);
      expect(result[0]?.database_name).toBeTruthy();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rejects a masked URL on the configured production host before marker-based acceptance", () => {
    const productionUrl = process.env.CODIQ_POSTGRES_URL;
    expect(productionUrl, "CODIQ_POSTGRES_URL must be available to test production-host rejection").toBeTruthy();

    const productionHost = new URL(productionUrl!).hostname;
    const maskedProductionUrl = `postgresql://redacted@${productionHost}/redacted?application_name=codiq_development`;

    expect(() => assertSafeTestDatabaseUrl(maskedProductionUrl, productionUrl)).toThrow(
      "the requested test host matches the configured production host",
    );
  });
});
