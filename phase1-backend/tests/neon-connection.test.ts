import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

async function verifyConnection(url: string) {
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await client.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows[0]?.ok).toBe(1);
  } finally {
    await client.$disconnect();
  }
}

describe("Neon PostgreSQL production secrets", () => {
  it("connects through the pooled CODIQ application URL", async () => {
    const url = process.env.CODIQ_POSTGRES_URL;
    expect(url).toMatch(/^postgres(?:ql)?:\/\//);
    await verifyConnection(url!);
  });

  it("connects through the direct CODIQ migration URL", async () => {
    const url = process.env.CODIQ_POSTGRES_URL_UNPOOLED;
    expect(url).toMatch(/^postgres(?:ql)?:\/\//);
    await verifyConnection(url!);
  });

  it("persists and reads a temporary platform-owner record through the pooled application URL", async () => {
    const url = process.env.CODIQ_POSTGRES_URL!;
    const client = new PrismaClient({ datasources: { db: { url } } });
    const email = `persistence-probe-${crypto.randomUUID()}@codiq.invalid`;
    try {
      const created = await client.platformOwner.create({ data: { email, passwordHash: "probe-not-a-login-password", displayName: "CODIQ Persistence Probe" } });
      const found = await client.platformOwner.findUnique({ where: { id: created.id }, select: { email: true } });
      expect(found?.email).toBe(email);
      await client.platformOwner.delete({ where: { id: created.id } });
      expect(await client.platformOwner.findUnique({ where: { id: created.id } })).toBeNull();
    } finally {
      await client.$disconnect();
    }
  });
});
