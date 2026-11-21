/**
 * codiq menus pass A — platform-owner directory reads.
 * A dedicated read-only service so the owner dashboard can list every store on
 * the platform without widening any merchant-scoped service. Pagination mirrors
 * the platform's one list contract: an opaque keyset cursor (20-2).
 */
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "./list-page.js";

export type PlatformStoreRow = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  /** ق-249: the one named status (active/paused/maintenance/suspended/closed) and the message behind it. */
  status: string;
  statusMessage: string | null;
  createdAt: Date;
  /** MD-6: null unless the platform owner granted the badge. */
  verifiedAt: Date | null;
  merchant: { businessName: string; email: string };
};

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const PLATFORM_STORES_KIND = "platform.stores";

export async function listPlatformStores(
  query: Record<string, unknown>
): Promise<{ stores: PlatformStoreRow[]; nextCursor: string | null }> {
  const limit = parseListLimit(query.limit);
  // 20-2: opaque `(createdAt, id)` keyset. There is no tenant to scope a cursor
  // to here — this list IS the platform owner's view of every store — and with
  // the keyset there is no anchor read to scope in the first place.
  const cursor = await readListCursor(PLATFORM_STORES_KIND, query.cursor, {
    legacy: async (id) => {
      const row = await prisma.store.findUnique({ where: { id }, select: { createdAt: true } });
      return row ? { value: row.createdAt } : null;
    },
  });
  const rows = await prisma.store.findMany({
    where: { ...keysetWhere("createdAt", "desc", cursor) },
    // MD-6: `verifiedAt` rides along so the owner sees at a glance which stores
    // carry the badge, without a request per row.
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      status: true,
      statusMessage: true,
      createdAt: true,
      verifiedAt: true,
      merchant: { select: { businessName: true, email: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(PLATFORM_STORES_KIND, last.createdAt, last.id)
  );
  return { stores: page, nextCursor };
}
