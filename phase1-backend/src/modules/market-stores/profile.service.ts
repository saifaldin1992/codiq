/**
 * The merchant's side: «ملفّي في السوق». What the market shows about his store,
 * whether it is in the market, what is still missing before he can ask, and
 * his reputation as the shoppers see it.
 *
 * Listing is a REQUEST, not a switch (docs/MARKETPLACE_PLAN.md §4): the
 * merchant moves his store to `pending`; only the owner moves it to `listed`.
 * He can always take it out again himself.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { assertWithinPlanLimit, replacementIncrementMb } from "../../services/entitlement.service.js";
import { governorateLabel, toGovernorateKey } from "../../services/governorates.js";
import { deleteStoreCoverObjects, putStoreCover } from "../../services/product-image-storage.service.js";
import { freshMetricsFor } from "./metrics.service.js";
import { badgeViews, grantedMarks, hoursView, parseEarnedBadges, storeCoverUrl, storeLogoUrl, TIER_LABELS } from "./presentation.js";
import type { MarketProfileInput } from "./schema.js";

const PROFILE_SELECT = {
  id: true, slug: true, name: true, logoObjectKey: true, coverObjectKey: true, businessType: true,
  governorateKey: true, districtId: true, district: { select: { nameAr: true } }, latitude: true, longitude: true, pickupEnabled: true,
  marketStatus: true, marketStatusAt: true, marketStatusNote: true, marketListedAt: true,
  verifiedAt: true, isBrand: true, boostedUntil: true, ambassadorUntil: true,
  openingHours: { select: { weekday: true, opensAt: true, closesAt: true }, orderBy: { weekday: "asc" } },
} satisfies Prisma.StoreSelect;

type ProfileRow = Prisma.StoreGetPayload<{ select: typeof PROFILE_SELECT }>;

/** What the market needs before a store may ask to join. Each item is a fact read from the store, never a stored flag. */
async function readinessOf(row: ProfileRow) {
  const activeProducts = await prisma.product.count({ where: { storeId: row.id, isActive: true, deletedAt: null } });
  const items = [
    { code: "logo", title: "شعار المتجر", done: row.logoObjectKey !== null },
    { code: "business_type", title: "نوع النشاط", done: row.businessType !== null },
    { code: "location", title: "المحافظة والمنطقة", done: row.governorateKey !== null && row.districtId !== null },
    { code: "products", title: "منتج واحد معروض على الأقلّ", done: activeProducts > 0 },
  ];
  return { items, ready: items.every((item) => item.done) };
}

async function profileView(row: ProfileRow) {
  const [readiness, metrics] = await Promise.all([readinessOf(row), freshMetricsFor(row.id)]);
  const marks = grantedMarks(row);
  const badges = parseEarnedBadges(metrics?.badges);
  return {
    storeSlug: row.slug,
    profile: {
      businessType: row.businessType,
      governorateKey: row.governorateKey,
      governorateName: row.governorateKey ? governorateLabel(row.governorateKey) : null,
      districtId: row.districtId,
      districtName: row.district?.nameAr ?? null,
      latitude: row.latitude,
      longitude: row.longitude,
      pickupEnabled: row.pickupEnabled,
      logoUrl: storeLogoUrl(row.slug, row.logoObjectKey),
      coverUrl: storeCoverUrl(row.slug, row.coverObjectKey),
      openingHours: hoursView(row.openingHours).days,
    },
    listing: {
      status: row.marketStatus,
      statusAt: row.marketStatusAt,
      note: row.marketStatusNote,
      listedAt: row.marketListedAt,
      marketPath: `/market/s/${encodeURIComponent(row.slug)}`,
      ...readiness,
    },
    reputation: {
      score: metrics?.score === null || metrics?.score === undefined ? null : Number(metrics.score),
      tier: metrics?.tier ?? null,
      tierLabel: metrics?.tier ? TIER_LABELS[metrics.tier as keyof typeof TIER_LABELS] : null,
      rating: metrics?.ratingAvg === null || metrics?.ratingAvg === undefined ? null : Number(metrics.ratingAvg),
      ratingCount: metrics?.ratingCount ?? 0,
      completedOrders: metrics?.completedOrders ?? 0,
      medianResponseMinutes: metrics?.medianResponseMinutes ?? null,
      cancelRate: metrics?.cancelRate === null || metrics?.cancelRate === undefined ? null : Number(metrics.cancelRate),
      computedAt: metrics?.computedAt ?? null,
    },
    badges: badgeViews(badges, marks),
  };
}

async function loadProfile(storeId: string) {
  return prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: PROFILE_SELECT });
}

export async function marketProfile(storeId: string) {
  return profileView(await loadProfile(storeId));
}

const timeValue = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

export async function updateMarketProfile(storeId: string, input: MarketProfileInput) {
  const governorateKey = input.governorateKey === null ? null : toGovernorateKey(input.governorateKey);
  if (input.governorateKey !== null && governorateKey === null) throw new HttpError(422, "UNKNOWN_GOVERNORATE", "المحافظة غير معروفة.");
  if (input.districtId !== null) {
    const district = await prisma.district.findFirst({ where: { id: input.districtId, governorateKey: governorateKey ?? undefined, isActive: true }, select: { id: true } });
    if (!district) throw new HttpError(422, "DISTRICT_NOT_IN_GOVERNORATE", "المنطقة المختارة ليست ضمن هذه المحافظة.");
  }
  await prisma.$transaction([
    prisma.store.update({
      where: { id: storeId },
      data: {
        businessType: input.businessType,
        governorateKey,
        districtId: input.districtId,
        latitude: input.latitude,
        longitude: input.longitude,
        pickupEnabled: input.pickupEnabled,
      },
    }),
    prisma.storeOpeningHour.deleteMany({ where: { storeId } }),
    prisma.storeOpeningHour.createMany({
      data: input.openingHours.map((row) => ({ storeId, weekday: row.weekday, opensAt: timeValue(row.opensAt), closesAt: timeValue(row.closesAt) })),
    }),
  ]);
  return marketProfile(storeId);
}

const REQUESTABLE_FROM = ["unlisted", "rejected", "delisted"];

export async function requestMarketListing(storeId: string) {
  const row = await loadProfile(storeId);
  if (!REQUESTABLE_FROM.includes(row.marketStatus)) {
    throw new HttpError(409, "MARKET_LISTING_ALREADY_REQUESTED", row.marketStatus === "listed" ? "متجرك معروض في السوق بالفعل." : "طلبك قيد المراجعة.");
  }
  const readiness = await readinessOf(row);
  if (!readiness.ready) {
    throw new HttpError(422, "MARKET_PROFILE_INCOMPLETE", "أكمل ملفّ المتجر قبل طلب الانضمام إلى السوق.", { missing: readiness.items.filter((item) => !item.done).map((item) => item.code) });
  }
  // The status test is repeated in the WHERE: two clicks in flight make one request, not two.
  const moved = await prisma.store.updateMany({
    where: { id: storeId, marketStatus: { in: REQUESTABLE_FROM } },
    data: { marketStatus: "pending", marketStatusAt: new Date(), marketStatusNote: null },
  });
  if (moved.count === 0) throw new HttpError(409, "MARKET_LISTING_ALREADY_REQUESTED", "طلبك قيد المراجعة.");
  return marketProfile(storeId);
}

/** The merchant takes his store out (or withdraws his request). Always allowed; asking again goes back to the owner. */
export async function leaveMarket(storeId: string) {
  const moved = await prisma.store.updateMany({
    where: { id: storeId, marketStatus: { in: ["pending", "listed"] } },
    data: { marketStatus: "unlisted", marketStatusAt: new Date(), marketStatusNote: null },
  });
  if (moved.count === 0) throw new HttpError(409, "MARKET_NOT_LISTED", "متجرك ليس في السوق.");
  return marketProfile(storeId);
}

export async function setStoreCover(storeId: string, merchantId: string, file: Express.Multer.File | undefined) {
  if (!file) throw new HttpError(422, "INVALID_COVER_IMAGE", "صورة الغلاف مطلوبة.");
  const current = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { coverObjectKey: true, coverByteSize: true } });
  const added = current.coverObjectKey ? replacementIncrementMb(file.size, current.coverByteSize) : Math.max(1, Math.ceil(file.size / (1024 * 1024)));
  if (added > 0) await assertWithinPlanLimit(prisma, merchantId, "max_image_storage_mb", added, "لرفع صورة الغلاف");
  const stored = await putStoreCover(storeId, file);
  try {
    await prisma.store.update({ where: { id: storeId }, data: { coverObjectKey: stored.objectKey, coverContentType: stored.contentType, coverByteSize: stored.byteSize } });
  } catch (error) {
    await deleteStoreCoverObjects([stored.objectKey]);
    throw error;
  }
  if (current.coverObjectKey) await deleteStoreCoverObjects([current.coverObjectKey]);
  return marketProfile(storeId);
}

export async function removeStoreCover(storeId: string) {
  const current = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { coverObjectKey: true } });
  if (!current.coverObjectKey) throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا توجد صورة غلاف لحذفها.");
  await prisma.store.update({ where: { id: storeId }, data: { coverObjectKey: null, coverContentType: null, coverByteSize: null } });
  await deleteStoreCoverObjects([current.coverObjectKey]);
  return marketProfile(storeId);
}
