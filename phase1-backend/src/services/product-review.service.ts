/**
 * CD-2 «التقييمات» — reviews a shopper can only write about something he bought.
 *
 * THE VERIFIED-BUYER BADGE IS THE `orderId` COLUMN. Writing a review requires
 * naming a completed order of this customer, in this store, that contained this
 * product; the order id is stored on the row and the FK keeps it there. There is
 * no `verified` boolean anywhere, because a boolean can be set and a purchase
 * cannot be faked into existence. If the row exists, the purchase existed.
 *
 * THE MERCHANT MAY HIDE THE WORDS, NEVER THE SCORE. This is the decision the
 * whole feature rests on, and it is narrower than «إشراف التاجر» sounds. A
 * merchant who can remove a review removes the one-star reviews, and the rating
 * on his shop stops being a rating; worse, every honest merchant's rating is
 * devalued with it, because a shopper cannot tell which kind he is looking at.
 *
 * So hiding suppresses the TEXT and nothing else:
 *   - the score stays in the average,
 *   - the storefront says how many are hidden,
 *   - the hide needs a written reason and lands in store_audit_events, where the
 *     platform owner can see a merchant who hides only his worst.
 *
 * The remedy against an abusive review is therefore real, and the number under
 * the stars stays true.
 */
import { HttpError } from "../auth/auth.errors.js";
import { encodeListCursor, keysetWhere, pageOf, readListCursor } from "./list-page.js";
import { prisma } from "../db/prisma.js";
import type { StoreActor } from "../auth/staff-permissions.js";
import { LIVE } from "./soft-delete/constants.js";
import { recordAuditEvent } from "./soft-delete/audit-log.service.js";

/**
 * A review the shopper has not withdrawn. Deliberately a DIFFERENT constant from
 * the trash's `LIVE` (`deletedAt: null`), which is what a product uses — spread
 * the wrong one into the wrong query and Prisma rejects it, which is exactly
 * what happened the first time these two shared a name.
 */
const NOT_WITHDRAWN = { withdrawnAt: null } as const;
/** Reviews per page on the storefront. */
const REVIEW_PAGE_SIZE = 20;

/**
 * The bounds, owned by the DOMAIN and imported by the HTTP schema — not
 * repeated there. Two copies of "a rating is 1 to 5" is how they end up
 * disagreeing, and the edge should express the rule, not re-decide it.
 */
export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;
export const REVIEW_BODY_MAX = 2000;
export const REVIEW_HIDE_REASON_MAX = 500;

export interface ReviewSummary {
  /** Mean of EVERY live review, hidden ones included — see the header. */
  average: number | null;
  count: number;
  /** Text suppressed by the merchant. Stated, never silently subtracted. */
  hiddenCount: number;
  /** How many gave each score, 1…5. */
  distribution: Record<string, number>;
}

/**
 * The service keeps its own guards even though the HTTP schema now runs first:
 * these functions are exported and callable from anywhere, and a public
 * function that trusts its caller is a public function waiting to be called
 * wrongly. They share the bounds above, so the two cannot drift.
 */
function parseRating(raw: unknown): number {
  const rating = Number(raw);
  if (!Number.isInteger(rating) || rating < REVIEW_RATING_MIN || rating > REVIEW_RATING_MAX) {
    throw new HttpError(422, "INVALID_REVIEW_RATING", "التقييم يجب أن يكون رقماً من 1 إلى 5.");
  }
  return rating;
}

function parseBody(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string")
    throw new HttpError(422, "INVALID_REVIEW_BODY", "نص المراجعة يجب أن يكون نصاً.");
  const body = raw.trim();
  if (!body) return null;
  if (body.length > REVIEW_BODY_MAX)
    throw new HttpError(422, "INVALID_REVIEW_BODY", "نص المراجعة يتجاوز 2000 حرف.");
  return body;
}

/**
 * The completed order that entitles this customer to review this product, or
 * null. Deliberately returns the EARLIEST such order: which one is arbitrary,
 * and an arbitrary choice that can change between calls would make the same
 * review point at different orders on a retry.
 */
async function entitlingOrder(
  storeId: string,
  customerId: string,
  productId: string
): Promise<{ id: string } | null> {
  return prisma.storeOrder.findFirst({
    where: {
      storeId,
      customerId,
      status: "completed",
      items: { some: { productId } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
}

export async function reviewSummary(storeId: string, productId: string): Promise<ReviewSummary> {
  const [groups, hiddenCount] = await Promise.all([
    prisma.productReview.groupBy({
      by: ["rating"],
      where: { storeId, productId, ...NOT_WITHDRAWN },
      _count: { _all: true },
    }),
    prisma.productReview.count({
      where: { storeId, productId, ...NOT_WITHDRAWN, hiddenAt: { not: null } },
    }),
  ]);
  const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let total = 0;
  let sum = 0;
  for (const group of groups) {
    distribution[String(group.rating)] = group._count._all;
    total += group._count._all;
    sum += group.rating * group._count._all;
  }
  return {
    // No reviews means no rating. Zero would read as a terrible one.
    average: total === 0 ? null : Math.round((sum / total) * 10) / 10,
    count: total,
    hiddenCount,
    distribution,
  };
}

/** The cursor's list kinds. One per list, so a cursor cannot cross lists. */
const PRODUCT_REVIEWS_KIND = "storefront.product.reviews";
const STORE_REVIEWS_KIND = "merchant.reviews";

/** Resolves a pre-20-2 bare review id inside the store that is asking. */
function legacyReviewCursor(storeId: string) {
  return async (id: string) => {
    const row = await prisma.productReview.findFirst({
      where: { id, storeId },
      select: { createdAt: true },
    });
    return row ? { value: row.createdAt } : null;
  };
}

/** The public list. Hidden reviews appear WITHOUT their text, never as a gap. */
/**
 * `viewerCustomerId` — ق-175: the reader may be the author. Reading stays public;
 * a customer session for THIS store only adds `mine` to his own row, so the
 * screen can offer «سحب مراجعتي» on exactly one line. The id itself never
 * leaves the server: the payload carries a boolean, not who wrote what.
 */
export async function listProductReviews(
  storeId: string,
  productId: string,
  query: Record<string, unknown>,
  viewerCustomerId: string | null = null
) {
  const cursor = await readListCursor(PRODUCT_REVIEWS_KIND, query.cursor, {
    legacy: legacyReviewCursor(storeId),
  });

  const rows = await prisma.productReview.findMany({
    where: {
      storeId,
      productId,
      ...NOT_WITHDRAWN,
      ...keysetWhere("createdAt", "desc", cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: REVIEW_PAGE_SIZE + 1,
    select: {
      id: true,
      rating: true,
      body: true,
      hiddenAt: true,
      createdAt: true,
      customerId: true,
      customer: { select: { fullName: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, REVIEW_PAGE_SIZE, (last) =>
    encodeListCursor(PRODUCT_REVIEWS_KIND, last.createdAt, last.id)
  );

  return {
    reviews: page.map((row) => ({
      id: row.id,
      rating: row.rating,
      // The text goes, the row stays. A hidden review that vanished entirely
      // would let the count and the visible list disagree, and a shopper
      // counting stars would find them missing.
      body: row.hiddenAt ? null : row.body,
      hidden: row.hiddenAt !== null,
      // Reviews are shown under a first name. A full name beside a rating and a
      // purchase is more of a stranger's identity than a shopper agreed to
      // publish when he pressed «إرسال».
      author: row.customer.fullName.trim().split(/\s+/)[0] ?? "زبون",
      createdAt: row.createdAt,
      /** Always true — the schema admits no other kind. Sent so the badge is data. */
      verifiedBuyer: true,
      mine: viewerCustomerId !== null && row.customerId === viewerCustomerId,
    })),
    nextCursor,
  };
}

/**
 * ق-200 — the store-wide public feed behind the front page's «آراء العملاء».
 *
 * NOT `listStoreReviews`: that is the merchant's moderation view and carries
 * hidden and withdrawn rows. This one shows only what a shopper may see — a
 * text, about a live product, not hidden, not withdrawn, and four stars or
 * better, because a testimonial rail that quotes complaints is a complaints
 * page under a friendlier heading.
 */
export async function publicStoreReviews(storeId: string, rawLimit: unknown) {
  const limit = Math.min(Math.max(Number(rawLimit) || 8, 1), 24);
  const rows = await prisma.productReview.findMany({
    where: {
      storeId,
      ...NOT_WITHDRAWN,
      hiddenAt: null,
      body: { not: null },
      rating: { gte: 4 },
      product: { isActive: true, deletedAt: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      rating: true,
      body: true,
      createdAt: true,
      customer: { select: { fullName: true } },
      product: { select: { id: true, name: true } },
    },
  });
  return {
    reviews: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      body: row.body,
      // First name only, as on the product page — a full name beside a purchase is more than he agreed to publish.
      author: row.customer.fullName.trim().split(/\s+/)[0] ?? "زبون",
      createdAt: row.createdAt,
      product: row.product,
    })),
  };
}

export async function upsertProductReview(
  storeId: string,
  customerId: string,
  productId: string,
  input: { rating: number; body?: string }
) {
  const rating = parseRating(input.rating);
  const body = parseBody(input.body);

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId, ...LIVE },
    select: { id: true },
  });
  if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المنتج غير موجود.");

  const order = await entitlingOrder(storeId, customerId, productId);
  if (!order) {
    throw new HttpError(
      403,
      "REVIEW_REQUIRES_PURCHASE",
      "لا يمكن تقييم منتج لم تشترِه وتستلمه. المراجعات هنا من مشترين فقط."
    );
  }

  const existing = await prisma.productReview.findFirst({
    where: { storeId, productId, customerId, ...NOT_WITHDRAWN },
    select: { id: true, hiddenAt: true },
  });

  if (existing) {
    // Editing his own review does NOT lift a merchant's moderation: otherwise
    // hiding abusive text would be undone by the person who wrote it, and the
    // hide would be worth nothing.
    return prisma.productReview.update({
      where: { id: existing.id },
      data: { rating, body },
      select: {
        id: true,
        rating: true,
        body: true,
        hiddenAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  return prisma.productReview.create({
    data: { storeId, productId, customerId, orderId: order.id, rating, body },
    select: {
      id: true,
      rating: true,
      body: true,
      hiddenAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * A shopper may withdraw his own review. Soft, so the partial unique index frees
 * up and he can write again — and `withdrawnAt`, never `deletedAt`, so it does
 * not land in the merchant's trash bin as a row he may "restore".
 */
export async function deleteOwnReview(storeId: string, customerId: string, reviewId: string) {
  const review = await prisma.productReview.findFirst({
    where: { id: reviewId, storeId, customerId, ...NOT_WITHDRAWN },
    select: { id: true },
  });
  if (!review) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المراجعة غير موجودة.");
  await prisma.productReview.update({
    where: { id: review.id },
    data: { withdrawnAt: new Date() },
  });
}

/**
 * The merchant's moderation. `hidden` true suppresses the text and requires a
 * reason; false restores it. Neither touches the rating.
 */
export async function setReviewHidden(
  storeId: string,
  actor: StoreActor,
  reviewId: string,
  input: { hidden: boolean; reason?: string }
) {
  if (typeof input.hidden !== "boolean")
    throw new HttpError(422, "INVALID_INPUT", "hidden يجب أن يكون true أو false.");
  const review = await prisma.productReview.findFirst({
    where: { id: reviewId, storeId, ...NOT_WITHDRAWN },
    select: { id: true, rating: true, hiddenAt: true, product: { select: { name: true } } },
  });
  if (!review) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المراجعة غير موجودة.");

  let reason: string | null = null;
  if (input.hidden) {
    if (typeof input.reason !== "string" || !input.reason.trim()) {
      throw new HttpError(
        422,
        "REVIEW_HIDE_REASON_REQUIRED",
        "إخفاء مراجعة يحتاج سبباً مكتوباً — يُسجَّل ويطّلع عليه المالك."
      );
    }
    reason = input.reason.trim();
    if (reason.length > REVIEW_HIDE_REASON_MAX)
      throw new HttpError(422, "INVALID_INPUT", "السبب يتجاوز 500 حرف.");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.productReview.update({
      where: { id: review.id },
      data: input.hidden
        ? { hiddenAt: new Date(), hiddenReason: reason }
        : { hiddenAt: null, hiddenReason: null },
      select: { id: true, rating: true, hiddenAt: true, hiddenReason: true },
    });
    // The trail is the counterweight to the power. A merchant who hides only
    // his one-star reviews leaves a legible pattern in the owner's log.
    await recordAuditEvent(tx, {
      storeId,
      entityType: "product_review",
      entityId: review.id,
      entityLabel: review.product.name,
      entitySecondary: `${review.rating}★`,
      action: input.hidden ? "review.hidden" : "review.unhidden",
      actor,
      metadata: reason ? { reason } : {},
    });
    return updated;
  });
}

/** The merchant's queue: his store's reviews, newest first, text and all. */
export async function listStoreReviews(storeId: string, query: Record<string, unknown>) {
  const cursor = await readListCursor(STORE_REVIEWS_KIND, query.cursor, {
    legacy: legacyReviewCursor(storeId),
  });
  const onlyHidden = query.hidden === "true";

  const rows = await prisma.productReview.findMany({
    where: {
      storeId,
      ...NOT_WITHDRAWN,
      ...(onlyHidden ? { hiddenAt: { not: null } } : {}),
      ...keysetWhere("createdAt", "desc", cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: REVIEW_PAGE_SIZE + 1,
    select: {
      id: true,
      rating: true,
      body: true,
      hiddenAt: true,
      hiddenReason: true,
      createdAt: true,
      product: { select: { id: true, name: true } },
      customer: { select: { fullName: true } },
      orderId: true,
    },
  });
  const { page, nextCursor } = pageOf(rows, REVIEW_PAGE_SIZE, (last) =>
    encodeListCursor(STORE_REVIEWS_KIND, last.createdAt, last.id)
  );
  return { reviews: page, nextCursor };
}
