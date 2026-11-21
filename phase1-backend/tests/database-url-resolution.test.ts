import { describe, expect, it } from "vitest";
import {
  resolveCodiqDatabaseUrl,
  resolveCodiqMigrationDatabaseUrl,
} from "../src/db/database-url.js";

describe("CODIQ PostgreSQL connection secret resolution", () => {
  it("prefers the dedicated PostgreSQL application secret over the platform DATABASE_URL", () => {
    const url = resolveCodiqDatabaseUrl({
      DATABASE_URL: "mysql://platform-reserved.invalid/database",
      CODIQ_POSTGRES_URL: "postgresql://app:secret@db.example.com:5432/codiq?sslmode=require",
    });
    expect(url).toBe("postgresql://app:secret@db.example.com:5432/codiq?sslmode=require");
  });

  it("uses the direct dedicated URL for migrations and rejects a non-PostgreSQL fallback", () => {
    expect(
      resolveCodiqMigrationDatabaseUrl({
        CODIQ_POSTGRES_URL: "postgresql://app:secret@pooler.example.com:5432/codiq?sslmode=require",
        CODIQ_POSTGRES_URL_UNPOOLED:
          "postgresql://app:secret@direct.example.com:5432/codiq?sslmode=require",
      })
    ).toBe("postgresql://app:secret@direct.example.com:5432/codiq?sslmode=require");
    expect(() =>
      resolveCodiqDatabaseUrl({ DATABASE_URL: "mysql://platform-reserved.invalid/database" })
    ).toThrow("standard PostgreSQL");
  });
});
