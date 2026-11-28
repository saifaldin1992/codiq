/**
 * Campaigns — owner. Split verbatim from campaigns.service.ts
 * (review batch 6, ت-٦); campaigns.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SLOT_PRODUCTS = 24;

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

export async function campaignById(id: string) {
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
