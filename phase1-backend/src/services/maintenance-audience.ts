/**
 * Who a maintenance notice goes to — moved verbatim out of maintenance.service.ts (review batch
 * 4) when the cancellation notice was added, so that file (over its size limit) would not grow.
 */
import { prisma } from "../db/prisma.js";
import type { WindowRow } from "./maintenance.service.js";

type Recipient = { id: string; email: string; businessName: string };

export async function windowAudience(window: WindowRow): Promise<Recipient[]> {
  if (window.scope === "merchant") return window.merchant ? [window.merchant] : [];
  if (window.scope === "store") {
    if (!window.storeId) return [];
    const store = await prisma.store.findUnique({
      where: { id: window.storeId },
      select: { merchant: { select: { id: true, email: true, businessName: true } } },
    });
    return store ? [store.merchant] : [];
  }
  // platform / service / capability: every merchant who can be affected, in pages — never
  // one unbounded read.
  const audience: Recipient[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Recipient[] = await prisma.merchant.findMany({
      where: {
        isActive: true,
        approvalStatus: "approved",
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true, email: true, businessName: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    audience.push(...page);
    if (page.length < 500) break;
    after = page[page.length - 1].id;
  }
  return audience;
}
