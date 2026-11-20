import { prisma } from "../../db/prisma.js";
import { GOVERNORATES } from "../../services/governorates.js";

export type MarketGeography = {
  governorates: { key: string; name: string; districts: { id: number; name: string }[] }[];
};

/**
 * Every governorate (in the platform's order) with its active districts.
 * Bounded by the seed — eighteen governorates and about a hundred and fifty
 * districts — so a picker gets the whole tree in one cacheable answer.
 */
export async function marketGeography(): Promise<MarketGeography> {
  const rows = await prisma.district.findMany({
    where: { isActive: true },
    orderBy: [{ governorateKey: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, governorateKey: true, nameAr: true },
  });
  const byGovernorate = new Map<string, { id: number; name: string }[]>();
  for (const row of rows) {
    const list = byGovernorate.get(row.governorateKey) ?? [];
    list.push({ id: row.id, name: row.nameAr });
    byGovernorate.set(row.governorateKey, list);
  }
  return {
    governorates: GOVERNORATES.map((governorate) => ({
      key: governorate.key,
      name: governorate.ar,
      districts: byGovernorate.get(governorate.key) ?? [],
    })),
  };
}
