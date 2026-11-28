/**
 * Campaigns — deals. Split verbatim from campaigns.service.ts
 * (review batch 6, ت-٦); campaigns.service.ts re-exports what it always exported.
 */
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { campaignById, UUID } from "./owner.js";

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
