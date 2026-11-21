/**
 * Marketplace M8a — campaigns and «عرض الساعة».
 *
 * The owner sets a campaign (its page, its days, its hours). A store puts its
 * products forward for an hour at a percentage off; the owner approves. During
 * the hour the product SELLS at the lower price — the store funds it, nothing
 * else moves: the price itself comes from codiq_live_price() wherever a price is
 * quoted or charged (see services/live-price.ts).
 *
 * Two rules keep the money honest:
 *   · a deal is fixed once its hour starts — no withdrawing, no re-deciding, no
 *     moving the hour — so the price a shopper was quoted is the price the store
 *     agreed to for exactly that hour;
 *   · a store can only put forward its own live product, at the campaign's
 *     minimum percentage or more, for an hour that has not started.
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import {
  decodeListCursor,
  encodeListCursor,
  pageOf,
  parseListLimit,
} from "../../services/list-page.js";
import { listMarketProducts } from "../market-catalog/products.service.js";
import type { MarketProductQuery } from "../market-catalog/schema.js";
import { marketStoreCardsByIds } from "../market-stores/directory.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT_PRODUCTS = 24;

type CampaignInput = {
  slug: string;
  title: string;
  subtitle?: string | null;
  startsAt: Date;
  endsAt: Date;
  minPercent: number;
  isPublished: boolean;
};

// ── the owner ──────────────────────────────────────────────────────────────

export async function ownerCampaigns() {
  const rows = await prisma.marketCampaign.findMany({
    orderBy: [{ startsAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      slug: true,
      title: true,
      subtitle: true,
      startsAt: true,
      endsAt: true,
      isPublished: true,
      minPercent: true,
      _count: { select: { slots: true, days: true } },
    },
  });
  const pending = await prisma.marketDeal.groupBy({
    by: ["slotId"],
    where: { status: "pending", slot: { campaignId: { in: rows.map((row) => row.id) } } },
    _count: { _all: true },
  });
  const slotCampaign = new Map(
    (
      await prisma.marketDealSlot.findMany({
        where: { id: { in: pending.map((row) => row.slotId) } },
        select: { id: true, campaignId: true },
      })
    ).map((slot) => [slot.id, slot.campaignId])
  );
  const pendingBy = new Map<string, number>();
  for (const row of pending) {
    const id = slotCampaign.get(row.slotId);
    if (id) pendingBy.set(id, (pendingBy.get(id) ?? 0) + row._count._all);
  }
  return {
    campaigns: rows.map(({ _count, ...row }) => ({
      ...row,
      slots: _count.slots,
      days: _count.days,
      pendingDeals: pendingBy.get(row.id) ?? 0,
    })),
  };
}

export async function createCampaign(input: CampaignInput) {
  if (await prisma.marketCampaign.findUnique({ where: { slug: input.slug }, select: { id: true } }))
    throw new HttpError(409, "CAMPAIGN_SLUG_TAKEN", "يوجد حملة بهذا المعرّف.");
  return { campaign: await prisma.marketCampaign.create({ data: input }) };
}

async function campaignById(id: string) {
  if (!UUID.test(id)) throw new HttpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة.");
  const campaign = await prisma.marketCampaign.findUnique({ where: { id } });
  if (!campaign) throw new HttpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة.");
  return campaign;
}

export async function updateCampaign(id: string, input: CampaignInput) {
  const campaign = await campaignById(id);
  if (
    input.slug !== campaign.slug &&
    (await prisma.marketCampaign.findUnique({ where: { slug: input.slug }, select: { id: true } }))
  )
    throw new HttpError(409, "CAMPAIGN_SLUG_TAKEN", "يوجد حملة بهذا المعرّف.");
  // An hour already inside the campaign may not fall outside it.
  const outside = await prisma.marketDealSlot.count({
    where: {
      campaignId: id,
      OR: [{ startsAt: { lt: input.startsAt } }, { endsAt: { gt: input.endsAt } }],
    },
  });
  if (outside)
    throw new HttpError(
      409,
      "CAMPAIGN_SLOTS_OUTSIDE",
      "بعض ساعات العروض تقع خارج المدّة الجديدة. احذفها أو عدّل المدّة."
    );
  return { campaign: await prisma.marketCampaign.update({ where: { id }, data: input }) };
}

export async function ownerCampaign(id: string) {
  const campaign = await campaignById(id);
  const [days, slots] = await Promise.all([
    prisma.marketCampaignDay.findMany({
      where: { campaignId: id },
      orderBy: { day: "asc" },
      take: 60,
    }),
    prisma.marketDealSlot.findMany({
      where: { campaignId: id },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 500,
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        _count: { select: { deals: true } },
      },
    }),
  ]);
  const counts = await prisma.marketDeal.groupBy({
    by: ["slotId", "status"],
    where: { slotId: { in: slots.map((slot) => slot.id) } },
    _count: { _all: true },
  });
  const count = (slotId: string, status: string) =>
    counts.find((row) => row.slotId === slotId && row.status === status)?._count._all ?? 0;
  return {
    campaign,
    days: days.map((day) => ({ ...day, day: day.day.toISOString().slice(0, 10) })),
    slots: slots.map(({ _count, ...slot }) => ({
      ...slot,
      approved: count(slot.id, "approved"),
      pending: count(slot.id, "pending"),
    })),
  };
}

export async function replaceCampaignDays(
  id: string,
  days: { day: string; title: string; note?: string | null }[]
) {
  const campaign = await campaignById(id);
  const first = campaign.startsAt.toISOString().slice(0, 10);
  const last = campaign.endsAt.toISOString().slice(0, 10);
  const outside = days.find((day) => day.day < first || day.day > last);
  if (outside)
    throw new HttpError(422, "CAMPAIGN_DAY_OUTSIDE", `اليوم ${outside.day} خارج مدّة الحملة.`);
  await prisma.$transaction([
    prisma.marketCampaignDay.deleteMany({ where: { campaignId: id } }),
    prisma.marketCampaignDay.createMany({
      data: days.map((day) => ({
        campaignId: id,
        day: new Date(`${day.day}T00:00:00Z`),
        title: day.title,
        note: day.note ?? null,
      })),
    }),
  ]);
  return ownerCampaign(id);
}

export async function addSlot(
  id: string,
  input: { title?: string | null; startsAt: Date; endsAt: Date }
) {
  const campaign = await campaignById(id);
  if (input.startsAt < campaign.startsAt || input.endsAt > campaign.endsAt)
    throw new HttpError(422, "SLOT_OUTSIDE_CAMPAIGN", "الساعة خارج مدّة الحملة.");
  const overlap = await prisma.marketDealSlot.findFirst({
    where: { campaignId: id, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } },
    select: { id: true },
  });
  if (overlap)
    throw new HttpError(409, "SLOT_OVERLAP", "تتداخل هذه الساعة مع ساعة أخرى في الحملة.");
  await prisma.marketDealSlot.create({
    data: {
      campaignId: id,
      title: input.title ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    },
  });
  return ownerCampaign(id);
}

export async function deleteSlot(id: string, slotId: string, now = new Date()) {
  const slot = await prisma.marketDealSlot.findFirst({ where: { id: slotId, campaignId: id } });
  if (!slot) throw new HttpError(404, "SLOT_NOT_FOUND", "الساعة غير موجودة.");
  if (
    slot.startsAt <= now &&
    (await prisma.marketDeal.count({ where: { slotId, status: "approved" } }))
  ) {
    throw new HttpError(409, "SLOT_STARTED", "بدأت هذه الساعة وفيها عروض معتمدة؛ لا تُحذف.");
  }
  await prisma.marketDealSlot.delete({ where: { id: slotId } });
  return ownerCampaign(id);
}

const DEALS_KIND = "market-campaign-deals";
export async function campaignDeals(
  id: string,
  status: string | undefined,
  rawCursor: unknown,
  rawLimit: unknown
) {
  await campaignById(id);
  const limit = parseListLimit(rawLimit, 100, 50);
  const cursor = decodeListCursor(`${DEALS_KIND}.${status ?? "all"}`, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketDeal.findMany({
    where: {
      slot: { campaignId: id },
      ...(status ? { status } : {}),
      ...(cursor && at
        ? { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      percentOff: true,
      status: true,
      decisionNote: true,
      createdAt: true,
      slot: { select: { id: true, title: true, startsAt: true, endsAt: true } },
      product: {
        select: {
          id: true,
          name: true,
          priceIqd: true,
          store: { select: { slug: true, name: true } },
        },
      },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(`${DEALS_KIND}.${status ?? "all"}`, last.createdAt, last.id)
  );
  return { deals: page, nextCursor };
}

export async function decideDeal(
  dealId: string,
  input: { approve: boolean; note?: string },
  now = new Date()
) {
  if (!UUID.test(dealId)) throw new HttpError(404, "DEAL_NOT_FOUND", "العرض غير موجود.");
  const deal = await prisma.marketDeal.findUnique({
    where: { id: dealId },
    include: { slot: true },
  });
  if (!deal) throw new HttpError(404, "DEAL_NOT_FOUND", "العرض غير موجود.");
  if (deal.slot.startsAt <= now)
    throw new HttpError(409, "SLOT_STARTED", "بدأت ساعة هذا العرض؛ لا يتغيّر قراره الآن.");
  if (deal.status === "withdrawn")
    throw new HttpError(409, "DEAL_WITHDRAWN", "سحب المتجر هذا العرض.");
  if (!input.approve && !input.note?.trim())
    throw new HttpError(422, "DEAL_REJECTION_NOTE_REQUIRED", "اكتب سبب الرفض — يراه المتجر.");
  const updated = await prisma.marketDeal.update({
    where: { id: dealId },
    data: {
      status: input.approve ? "approved" : "rejected",
      decisionNote: input.note?.trim() || null,
      decidedAt: now,
    },
    select: { id: true, status: true, decisionNote: true, decidedAt: true },
  });
  return { deal: updated };
}

// ── the store ──────────────────────────────────────────────────────────────

/** Campaigns a store can still join: published, not over, with their future hours and the store's own deals. */
export async function storeCampaigns(storeId: string, now = new Date()) {
  const campaigns = await prisma.marketCampaign.findMany({
    where: { isPublished: true, endsAt: { gt: now } },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: 10,
    select: {
      id: true,
      slug: true,
      title: true,
      subtitle: true,
      startsAt: true,
      endsAt: true,
      minPercent: true,
      slots: {
        where: { endsAt: { gt: now } },
        orderBy: { startsAt: "asc" },
        take: 200,
        select: { id: true, title: true, startsAt: true, endsAt: true },
      },
    },
  });
  const slotIds = campaigns.flatMap((campaign) => campaign.slots.map((slot) => slot.id));
  const deals = await prisma.marketDeal.findMany({
    where: { storeId, slotId: { in: slotIds } },
    orderBy: { createdAt: "asc" },
    take: 1000,
    select: {
      id: true,
      slotId: true,
      percentOff: true,
      status: true,
      decisionNote: true,
      product: { select: { id: true, name: true, priceIqd: true } },
    },
  });
  return {
    now,
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      slots: campaign.slots.map((slot) => ({
        ...slot,
        open: slot.startsAt > now,
        deals: deals
          .filter((deal) => deal.slotId === slot.id)
          .map(({ slotId: _slotId, ...deal }) => deal),
      })),
    })),
  };
}

export async function proposeDeal(
  storeId: string,
  input: { slotId: string; productId: string; percentOff: number },
  now = new Date()
) {
  const slot = await prisma.marketDealSlot.findUnique({
    where: { id: input.slotId },
    include: { campaign: true },
  });
  if (!slot || !slot.campaign.isPublished)
    throw new HttpError(404, "SLOT_NOT_FOUND", "الساعة غير موجودة.");
  if (slot.startsAt <= now)
    throw new HttpError(409, "SLOT_STARTED", "بدأت هذه الساعة أو انتهت؛ اختر ساعة قادمة.");
  if (input.percentOff < slot.campaign.minPercent)
    throw new HttpError(
      422,
      "DEAL_PERCENT_TOO_LOW",
      `أقلّ خصم في هذه الحملة ${slot.campaign.minPercent}%.`
    );
  const product = await prisma.product.findFirst({
    where: { id: input.productId, storeId, isActive: true, deletedAt: null },
    select: { id: true, store: { select: { marketStatus: true } } },
  });
  if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "المنتج غير موجود في متجرك.");
  if (product.store.marketStatus !== "listed")
    throw new HttpError(409, "STORE_NOT_LISTED", "متجرك ليس معروضاً في السوق بعد.");
  const existing = await prisma.marketDeal.findUnique({
    where: { slotId_productId: { slotId: slot.id, productId: product.id } },
  });
  if (existing && existing.status !== "withdrawn" && existing.status !== "rejected")
    throw new HttpError(409, "DEAL_EXISTS", "هذا المنتج مقترح في هذه الساعة بالفعل.");
  const data = {
    percentOff: input.percentOff,
    status: "pending",
    decisionNote: null,
    decidedAt: null,
  };
  const deal = existing
    ? await prisma.marketDeal.update({
        where: { id: existing.id },
        data,
        select: { id: true, status: true, percentOff: true },
      })
    : await prisma.marketDeal.create({
        data: { ...data, slotId: slot.id, storeId, productId: product.id },
        select: { id: true, status: true, percentOff: true },
      });
  return { deal };
}

export async function withdrawDeal(storeId: string, dealId: string, now = new Date()) {
  if (!UUID.test(dealId)) throw new HttpError(404, "DEAL_NOT_FOUND", "العرض غير موجود.");
  const deal = await prisma.marketDeal.findFirst({
    where: { id: dealId, storeId },
    include: { slot: true },
  });
  if (!deal) throw new HttpError(404, "DEAL_NOT_FOUND", "العرض غير موجود.");
  if (deal.slot.startsAt <= now)
    throw new HttpError(409, "SLOT_STARTED", "بدأت ساعة هذا العرض؛ لا يُسحب الآن.");
  return {
    deal: await prisma.marketDeal.update({
      where: { id: deal.id },
      data: { status: "withdrawn" },
      select: { id: true, status: true },
    }),
  };
}

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
