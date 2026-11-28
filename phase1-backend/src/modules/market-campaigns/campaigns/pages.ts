/**
 * Campaigns — pages. Split verbatim from campaigns.service.ts
 * (review batch 6, ت-٦); campaigns.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { listMarketProducts } from "../../market-catalog/products.service.js";
import type { MarketProductQuery } from "../../market-catalog/schema.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { marketStoreCardsByIds } from "../../market-stores/directory.service.js";
import { SLOT_PRODUCTS } from "./owner.js";

// ── the shopper ────────────────────────────────────────────────────────────

async function slotProducts(slotId: string) {
  const deals = await prisma.marketDeal.findMany({
    where: { slotId, status: "approved" },
    orderBy: [{ percentOff: "desc" }, { id: "asc" }],
    take: SLOT_PRODUCTS,
    select: { productId: true },
  });
  if (!deals.length) return [];
  const ids = deals.map((deal) => deal.productId);
  const cards = (
    await listMarketProducts({ ids, limit: SLOT_PRODUCTS, period: "month" } as MarketProductQuery)
  ).products;
  const byId = new Map(cards.map((card) => [card.id, card]));
  return ids
    .map((id) => byId.get(id))
    .filter((card): card is NonNullable<typeof card> => Boolean(card));
}

/** The campaign page: its days, the hour running now with its products, the next hours, the stores taking part. */
export async function campaignPage(slug: string, now = new Date()) {
  const campaign = await prisma.marketCampaign.findFirst({
    where: { slug, isPublished: true },
    select: { id: true, slug: true, title: true, subtitle: true, startsAt: true, endsAt: true },
  });
  if (!campaign) throw new HttpError(404, "CAMPAIGN_NOT_FOUND", "هذه الحملة غير موجودة أو انتهت.");
  const [days, slots] = await Promise.all([
    prisma.marketCampaignDay.findMany({
      where: { campaignId: campaign.id },
      orderBy: { day: "asc" },
      take: 60,
      select: { day: true, title: true, note: true },
    }),
    prisma.marketDealSlot.findMany({
      where: { campaignId: campaign.id },
      orderBy: { startsAt: "asc" },
      take: 500,
      select: { id: true, title: true, startsAt: true, endsAt: true },
    }),
  ]);
  const current = slots.find((slot) => slot.startsAt <= now && slot.endsAt > now) ?? null;
  const upcoming = slots.filter((slot) => slot.startsAt > now).slice(0, 6);
  const [currentProducts, nextProducts, storeRows] = await Promise.all([
    current ? slotProducts(current.id) : Promise.resolve([]),
    upcoming[0] ? slotProducts(upcoming[0].id) : Promise.resolve([]),
    prisma.marketDeal.findMany({
      where: { status: "approved", slot: { campaignId: campaign.id } },
      distinct: ["storeId"],
      take: 24,
      select: { storeId: true },
    }),
  ]);
  const today = new Date(now.valueOf() + 3 * 3_600_000).toISOString().slice(0, 10); // Baghdad, UTC+3
  return {
    now,
    campaign: {
      ...campaign,
      status: now < campaign.startsAt ? "upcoming" : now >= campaign.endsAt ? "ended" : "live",
    },
    days: days.map((day) => {
      const key = day.day.toISOString().slice(0, 10);
      return {
        day: key,
        title: day.title,
        note: day.note,
        isToday: key === today,
        isPast: key < today,
      };
    }),
    current: current ? { ...current, products: currentProducts } : null,
    // The next hour's products are shown so the shopper can come back — at today's price, until it starts.
    upcoming: upcoming.map((slot, index) => ({
      ...slot,
      products: index === 0 ? nextProducts : undefined,
    })),
    stores: await marketStoreCardsByIds(storeRows.map((row) => row.storeId)),
  };
}

/** For the front page: campaigns running or starting within a day. */
export async function liveCampaigns(now = new Date()) {
  const campaigns = await prisma.marketCampaign.findMany({
    where: {
      isPublished: true,
      endsAt: { gt: now },
      startsAt: { lt: new Date(now.valueOf() + 86_400_000) },
    },
    orderBy: { startsAt: "asc" },
    take: 3,
    select: {
      slug: true,
      title: true,
      subtitle: true,
      startsAt: true,
      endsAt: true,
      slots: {
        where: { endsAt: { gt: now } },
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true, endsAt: true, title: true },
      },
    },
  });
  return {
    now,
    campaigns: campaigns.map(({ slots, ...campaign }) => ({
      ...campaign,
      nextHour: slots[0] ? { ...slots[0], running: slots[0].startsAt <= now } : null,
    })),
  };
}
