/**
 * ق-180 — the daily message ceilings, read by the merchant and set by the owner.
 *
 * PG-3 and 19-د put three ceilings on every store as COLUMNS rather than
 * constants — «so the platform owner can tighten a particular store without a
 * deploy» — and then nothing read them into a screen and nothing could write
 * them but a test. A merchant whose messages were deferred for a day saw
 * «إعادة محاولة» (ق-165 gave him the reason); the owner had no control at
 * all, though the columns were built for his hand.
 *
 * The two operational ceilings are anti-abuse walls from 19-د, so the MERCHANT
 * reads and never writes any of the three: the merchant settings schema does
 * not admit them, and this module is the owner's door.
 */
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { DEFAULT_OPERATIONAL_DAILY_CAP, DEFAULT_OPERATIONAL_RECIPIENT_DAILY_CAP } from "../notifications/messaging-compliance.service.js";

/** PG-3's seed value — the column default in prisma/schema.prisma. */
export const DEFAULT_MARKETING_DAILY_CAP = 200;

export interface MessagingCaps {
  marketingDailyCap: number;
  operationalDailyCap: number;
  operationalRecipientDailyCap: number;
}

export function capsFromRow(row: Partial<MessagingCaps> | null | undefined): MessagingCaps {
  return {
    marketingDailyCap: row?.marketingDailyCap ?? DEFAULT_MARKETING_DAILY_CAP,
    operationalDailyCap: row?.operationalDailyCap ?? DEFAULT_OPERATIONAL_DAILY_CAP,
    operationalRecipientDailyCap: row?.operationalRecipientDailyCap ?? DEFAULT_OPERATIONAL_RECIPIENT_DAILY_CAP,
  };
}

async function storeBySlug(storeSlug: string) {
  const store = await prisma.store.findUnique({ where: { slug: storeSlug }, select: { id: true, slug: true, name: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
  return store;
}

export async function storeMessagingCaps(storeSlug: string): Promise<{ store: { slug: string; name: string }; caps: MessagingCaps }> {
  const store = await storeBySlug(storeSlug);
  const row = await prisma.notificationSettings.findUnique({
    where: { storeId: store.id },
    select: { marketingDailyCap: true, operationalDailyCap: true, operationalRecipientDailyCap: true },
  });
  return { store: { slug: store.slug, name: store.name }, caps: capsFromRow(row) };
}

export async function updateStoreMessagingCaps(storeSlug: string, input: Partial<MessagingCaps>): Promise<{ store: { slug: string; name: string }; caps: MessagingCaps }> {
  const store = await storeBySlug(storeSlug);
  const data = {
    ...(input.marketingDailyCap !== undefined ? { marketingDailyCap: input.marketingDailyCap } : {}),
    ...(input.operationalDailyCap !== undefined ? { operationalDailyCap: input.operationalDailyCap } : {}),
    ...(input.operationalRecipientDailyCap !== undefined ? { operationalRecipientDailyCap: input.operationalRecipientDailyCap } : {}),
  };
  // A store that never touched its notification settings has no row yet; the
  // ceilings are still real for it (the worker reads the defaults), so the
  // owner's first tightening creates the row rather than failing on its absence.
  const row = await prisma.notificationSettings.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id, ...data },
    update: data,
    select: { marketingDailyCap: true, operationalDailyCap: true, operationalRecipientDailyCap: true },
  });
  return { store: { slug: store.slug, name: store.name }, caps: capsFromRow(row) };
}
