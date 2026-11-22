import { parseDeliveryFields } from "./delivery.service.js";
import {
  awardPlatformPoints,
  clawbackPlatformPoints,
  grantWheelSpins,
  releasePlatformCoupon,
  revokeWheelSpins,
} from "./platform-rewards.service.js";
import type { Prisma, StoreOrder } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
  type ListCursor,
} from "./list-page.js";
import { phoneNeedle } from "./merchant-search.service.js";
import { normalizeTagKey } from "./order-notes.service.js";
import { mergeSearchPages, searchEngine, type SearchPage } from "./search/index.js";
import { awardLoyaltyPoints, reverseLoyaltyForReturn } from "./loyalty.service.js";
import {
  enqueueCourierDispatched,
  enqueueOrderStatusChanged,
} from "../notifications/notification-outbox.service.js";
import { recordOrderCompletion, recordOrderReturn } from "./finance.service.js";
import { settleStorefrontReservations } from "./storefront.service.js";
import { domainEvents } from "../events/domain-events.js";

export const ORDER_STATUSES = [
  "new",
  "processing",
  "preparation",
  "out_for_delivery",
  "completed",
  "cancelled",
  "rejected",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["processing", "cancelled", "rejected"],
  processing: ["preparation", "cancelled"],
  preparation: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["completed", "returned"],
  completed: ["returned"],
  cancelled: [],
  rejected: [],
  returned: [],
};

/**
 * Statuses with no outgoing edge — DERIVED from the table above so the two can
 * never drift. The bulk UI reads this notion (through its own mirror of the same
 * table) to decide which target statuses deserve an irreversible-action
 * confirmation, and the md1 suite asserts the derived set.
 */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (status) => transitions[status].length === 0
);

function orderStatus(value: unknown, code = "INVALID_ORDER_STATUS"): OrderStatus {
  if (typeof value !== "string" || !ORDER_STATUSES.includes(value as OrderStatus)) {
    throw new HttpError(422, code, "Order status is not supported.");
  }
  return value as OrderStatus;
}

/**
 * The ONE definition of a valid transition note. Exported so the bulk sequencer
 * can validate the shared `note` ONCE, up-front, exactly as it validates
 * `toStatus` — instead of handing a malformed note to fifty per-order
 * transitions and turning one request error into fifty database round trips and
 * fifty identical failures.
 */
export function orderTransitionNote(value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 1000)
    throw new HttpError(400, "INVALID_ORDER_NOTE", "note must contain at most 1000 characters.");
  return value.trim();
}

function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string")
    throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()))
    throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  return parsed;
}

/**
 * 20-2: the two order lists are the ONE pair that already carried an encoded
 * cursor before this branch — `base64url({id, createdAt})`, with no version and
 * no list kind. That payload is what a merchant's open browser tab is still
 * holding, so it is decoded here, once, and mapped onto the shared shape rather
 * than being refused. It is deliberately NOT in `list-page.ts`: this is the
 * only list that ever minted it, and the day it can no longer be in flight this
 * function and its two call sites are the whole of the deletion.
 */
function legacyOrderCursor(raw: string): { value: Date; id: string } | undefined {
  let decoded: { id?: unknown; createdAt?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof decoded?.id !== "string" || typeof decoded?.createdAt !== "string") return undefined;
  const createdAt = new Date(decoded.createdAt);
  if (Number.isNaN(createdAt.valueOf())) return undefined;
  return { value: createdAt, id: decoded.id };
}

/** The cursor's list kind. The merchant list and the platform list are NOT the
 *  same list: a cursor from one is refused by the other, on purpose — they
 *  filter differently and a page carried across would silently skip rows. */
const MERCHANT_ORDERS_KIND = "merchant.orders";
const PLATFORM_ORDERS_KIND = "platform.orders";

function orderCursor(kind: string, raw: unknown): Promise<ListCursor | undefined> {
  return readListCursor(kind, raw, { legacyEncoded: legacyOrderCursor });
}

const orderInclude = {
  store: {
    select: {
      id: true,
      slug: true,
      name: true,
      merchant: { select: { id: true, businessName: true } },
    },
  },
  // Marketplace M5: `addons` names the paid extras inside each line's price, so the merchant packs them.
  items: {
    select: {
      id: true,
      productId: true,
      variantId: true,
      sku: true,
      productName: true,
      variantName: true,
      quantity: true,
      unitPriceIqd: true,
      lineTotalIqd: true,
      addons: true,
    },
  },
  statusEvents: {
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      actorKind: true,
      actorId: true,
      note: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

/** Lists pass the bare row (the platform list adds `store`); detail reads add every relation. */
function orderPayload(
  order: StoreOrder & { store?: object; items?: object[]; statusEvents?: object[] }
) {
  return {
    id: order.id,
    storeId: order.storeId,
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName,
    customerId: order.customerId,
    customerEmail: order.customerEmail,
    recipientPhone: order.recipientPhone,
    shippingGovernorate: order.shippingGovernorate,
    shippingAddressLine1: order.shippingAddressLine1,
    shippingAddressLine2: order.shippingAddressLine2,
    subtotalIqd: order.subtotalIqd,
    deliveryFeeIqd: order.deliveryFeeIqd,
    discountIqd: order.discountIqd,
    totalIqd: order.totalIqd,
    // ق-187: the loyalty pair is part of the ARITHMETIC, not a nicety.
    // `storefront.service.ts` prices an order as
    //   total = subtotal − discount − loyaltyDiscount + delivery
    // and this payload used to emit every term of that sum except the loyalty
    // one. So a merchant reconciling cash-on-delivery collections saw four
    // numbers that do not add up — a hole exactly the size of the points his
    // shopper redeemed, on the screen he trusts to tell him what the courier
    // owes him. The columns were on the row the whole time.
    loyaltyPointsSpent: order.loyaltyPointsSpent ?? 0,
    loyaltyDiscountIqd: order.loyaltyDiscountIqd ?? 0,
    // Marketplace M8b: a market coupon the PLATFORM paid — the courier collects less, the store is still paid it.
    platformDiscountIqd: order.platformDiscountIqd ?? 0,
    couponCode: order.couponCode ?? null,
    prescriptionStatus: order.prescriptionStatus ?? null,
    // PG-5: a note stored and never shown is worse than no note — the customer
    // believes he has been heard and the courier still knocks on the wrong door.
    customerNote: order.customerNote ?? null,
    // ق-246: the parcel after the shelf — who took it, its waybill, when, and
    // whether its cash came back. NULL until the merchant records them.
    courierName: order.courierName ?? null,
    trackingNumber: order.trackingNumber ?? null,
    handedOverAt: order.handedOverAt ?? null,
    codCollectedAt: order.codCollectedAt ?? null,
    // Marketplace M5: a counter pick-up — no courier, no delivery fee; the store hands it over itself.
    fulfilment: order.fulfilment ?? "delivery",
    paymentStatus: order.paymentStatus,
    source: order.source,
    version: order.version,
    statusUpdatedAt: order.statusUpdatedAt,
    createdAt: order.createdAt,
    ...(order.store ? { store: order.store } : {}),
    ...(order.items ? { items: order.items } : {}),
    ...(order.statusEvents ? { statusEvents: order.statusEvents } : {}),
  };
}

/** How many distinct tags the store's filter chips may offer at once. */
const ORDER_TAG_FACET_LIMIT = 50;

/**
 * PG-6 (ق-74): how many ranked matches a `q` narrows the list to before the
 * page's own keyset takes over.
 *
 * The list keeps its EXISTING envelope and its EXISTING `createdAt DESC, id
 * DESC` cursor — the engine's contract forbids minting a cursor here, which is
 * what lets 20-2 sweep this route with the other sixty-five. So `q` is applied
 * as an `id IN (…)` narrowing and the keyset pages through the result. The cap
 * is the honest cost of that: a needle matching more than 200 orders shows the
 * 200 best-ranked ones. 20-2 replaces this with a `(rank, id)` cursor, which is
 * exactly why the engine already returns a total, stable order.
 */
const SEARCH_ID_CAP = 200;

/**
 * PG-6: order search widens from «order number only» to order number + customer
 * name + recipient phone.
 *
 * The phone probe carries `phoneNeedle`'s gate — an optional `+`, digits and
 * phone punctuation, at least four digits — which exists because `AB-0001` used
 * to surface the customer whose phone merely contains `0001`. Owner decision 2
 * puts that gate on EVERY phone surface, not only the palette.
 *
 * `storeId === null` is the platform-owner variant: cross-tenant by design, and
 * it reaches a different engine method so there is no store filter to forget.
 */
async function orderSearchIds(storeId: string | null, q: string): Promise<string[]> {
  const phone = phoneNeedle(q);
  const base = { needle: q, limit: SEARCH_ID_CAP };
  const pages: SearchPage[] =
    storeId === null
      ? await Promise.all([
          searchEngine.searchPlatformOrders("orders.orderNumber", base),
          searchEngine.searchPlatformOrders("orders.customerName", base),
          ...(phone
            ? [
                searchEngine.searchPlatformOrders("orders.recipientPhone", {
                  ...base,
                  needle: phone,
                }),
              ]
            : []),
        ])
      : await Promise.all([
          searchEngine.search("orders.orderNumber", { ...base, storeId }),
          searchEngine.search("orders.customerName", { ...base, storeId }),
          ...(phone
            ? [searchEngine.search("orders.recipientPhone", { ...base, storeId, needle: phone })]
            : []),
        ]);
  return mergeSearchPages(pages, SEARCH_ID_CAP).hits.map((hit) => hit.id);
}

export async function listStoreOrders(storeId: string, query: Record<string, unknown>) {
  const limit = parseListLimit(query.limit);
  const cursor = await orderCursor(MERCHANT_ORDERS_KIND, query.cursor);
  const status =
    query.status === undefined || query.status === ""
      ? undefined
      : orderStatus(query.status, "INVALID_ORDER_STATUS_FILTER");
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined;
  // MD-1 review fix: the internal-tag filter is a SERVER filter. Filtering the
  // 25-row page in the browser answered a different question than the merchant
  // asked — a store with 500 orders and 30 «عاجل» ones showed two, and the bulk
  // action then operated on that misleading subset. The relation filter rides
  // the additive order_tags(store_id, tag_normalized) index.
  const tag =
    typeof query.tag === "string" && query.tag.trim() ? orderTagFilter(query.tag) : undefined;
  const where: Prisma.StoreOrderWhereInput = {
    storeId,
    ...(status ? { status } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    // PG-6: `orderNumber: { contains: q }` became a three-column engine search
    // (number + customer name + gated phone) narrowed to ids, so the envelope
    // and the cursor below are untouched.
    ...(q ? { id: { in: await orderSearchIds(storeId, q) } } : {}),
    ...(tag ? { internalTags: { some: { storeId, tagNormalized: tag } } } : {}),
    ...keysetWhere("createdAt", "desc", cursor),
  };
  // MD-1: the internal tag relation rides the MERCHANT list row so the tag chips
  // need no extra request per row. Naming the relation here is what makes it
  // visible — the platform and storefront order payloads never name it, so they
  // stay tag-free by construction.
  const [rows, facets] = await Promise.all([
    prisma.storeOrder.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerName: true,
        totalIqd: true,
        version: true,
        createdAt: true,
        statusUpdatedAt: true,
        internalTags: {
          select: { tag: true },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        },
      },
    }),
    // The chips must offer every tag the STORE uses, not only the ones that
    // happen to sit on the loaded page — otherwise a tag whose orders are all on
    // page 3 is unreachable. One grouped, indexed read per page.
    prisma.orderTag.groupBy({
      by: ["tagNormalized"],
      where: { storeId },
      _max: { tag: true },
      orderBy: { tagNormalized: "asc" },
      take: ORDER_TAG_FACET_LIMIT,
    }),
  ]);
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(MERCHANT_ORDERS_KIND, last.createdAt, last.id)
  );
  return {
    orders: page.map((order) => ({
      ...order,
      internalTags: order.internalTags.map((row) => row.tag),
    })),
    nextCursor,
    availableTags: facets
      .map((facet) => facet._max.tag)
      .filter((value): value is string => typeof value === "string"),
    appliedTag: tag ? String(query.tag).trim().replace(/\s+/g, " ") : null,
  };
}

/** The same key as order-notes.service.ts writes (`normalizeTagKey`) — one definition. */
function orderTagFilter(value: string): string {
  const normalized = normalizeTagKey(value);
  if (normalized.length > 24)
    throw new HttpError(422, "INVALID_ORDER_TAG_FILTER", "طول الوسم يجب ألا يتجاوز 24 حرفاً.");
  return normalized;
}

export async function orderForStore(storeId: string, orderId: string) {
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId },
    include: orderInclude,
  });
  if (!order)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested order was not found in this store."
    );
  return orderPayload(order);
}

export async function orderHistoryForStore(storeId: string, orderId: string) {
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId },
    select: { id: true },
  });
  if (!order)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested order was not found in this store."
    );
  return prisma.orderStatusEvent.findMany({
    where: { storeId, orderId },
    orderBy: { createdAt: "asc" },
  });
}

// PG-1 adds "customer": a shopper may cancel their own order while it is still
// `new`. The kind is recorded on the status event, so the history shows who
// stopped the order. order_status_events.actor_kind already permits 'customer'
// (phase 8A), so no constraint change is needed.
/** Marketplace M13: `system` is the payments module cancelling an order nobody paid for in time (id = the payment). */
export type OrderTransitionActor = {
  kind: "merchant" | "staff" | "customer" | "system";
  id: string;
};

export async function transitionOrderStatus(
  storeId: string,
  actor: OrderTransitionActor,
  orderId: string,
  input: {
    toStatus?: unknown;
    expectedVersion?: unknown;
    note?: unknown;
    courierName?: unknown;
    trackingNumber?: unknown;
  }
) {
  // ق-246: the «قيد التوصيل» click is the handover — the one moment the
  // merchant knows which courier has the parcel. The fields ride the same
  // transaction as the transition so a courier is never recorded on an order
  // whose status change failed. Parsed up front: a bad courier name refuses
  // the whole call before anything is written, like a bad note does.
  const delivery = parseDeliveryFields(input);
  const toStatus = orderStatus(input.toStatus, "INVALID_ORDER_TRANSITION");
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new HttpError(
      400,
      "INVALID_ORDER_VERSION",
      "expectedVersion must be a positive integer."
    );
  const note = orderTransitionNote(input.note);
  let fromStatusForEvent = "";
  const payload = await prisma.$transaction(async (tx) => {
    const current = await tx.storeOrder.findFirst({
      where: { id: orderId, storeId },
      select: {
        id: true,
        status: true,
        version: true,
        source: true,
        orderNumber: true,
        customerEmail: true,
        subtotalIqd: true,
        deliveryFeeIqd: true,
        discountIqd: true,
        prescriptionStatus: true,
        customerId: true,
        loyaltyDiscountIqd: true,
        platformDiscountIqd: true,
        paymentStatus: true,
      },
    });
    if (!current)
      throw new HttpError(
        404,
        "RESOURCE_NOT_FOUND",
        "The requested order was not found in this store."
      );
    if (current.version !== expectedVersion)
      throw new HttpError(
        409,
        "ORDER_VERSION_CONFLICT",
        "The order was changed by another request."
      );
    const fromStatus = orderStatus(current.status);
    fromStatusForEvent = fromStatus;
    if (!transitions[fromStatus].includes(toStatus))
      throw new HttpError(
        422,
        "INVALID_ORDER_TRANSITION",
        `${fromStatus} cannot transition to ${toStatus}.`
      );
    // Phase 20B-1: prescription gate — sits EXACTLY after edge validation. Only
    // the new→processing edge is blocked until the prescription is approved;
    // cancel/reject from `new` stay open, and orders without a prescription
    // (prescriptionStatus NULL) are untouched.
    if (
      fromStatus === "new" &&
      toStatus === "processing" &&
      current.prescriptionStatus !== null &&
      current.prescriptionStatus !== "approved"
    ) {
      throw new HttpError(
        422,
        "PRESCRIPTION_NOT_APPROVED",
        "This order requires an approved prescription before processing."
      );
    }
    // Marketplace M13: an order paid online is not accepted before the money arrives —
    // the store would prepare goods the shopper may never pay for.
    if (
      fromStatus === "new" &&
      toStatus === "processing" &&
      current.paymentStatus === "awaiting_payment"
    ) {
      throw new HttpError(
        422,
        "ORDER_PAYMENT_PENDING",
        "الزبون لم يُكمل الدفع الإلكترونيّ بعد — اقبل الطلب بعد وصول الدفع."
      );
    }
    const result = await tx.storeOrder.updateMany({
      where: { id: orderId, storeId, version: expectedVersion },
      data: {
        status: toStatus,
        version: { increment: 1 },
        statusUpdatedAt: new Date(),
        updatedByKind: actor.kind,
        // ق-246: on the handover edge, a named courier is the handover itself.
        ...(toStatus === "out_for_delivery" && delivery.courierName
          ? { courierName: delivery.courierName, handedOverAt: new Date() }
          : {}),
        ...(toStatus === "out_for_delivery" && delivery.trackingNumber
          ? { trackingNumber: delivery.trackingNumber }
          : {}),
      },
    });
    if (result.count !== 1)
      throw new HttpError(
        409,
        "ORDER_VERSION_CONFLICT",
        "The order was changed by another request."
      );
    await tx.orderStatusEvent.create({
      data: {
        storeId,
        orderId,
        fromStatus,
        toStatus,
        actorKind: actor.kind,
        actorId: actor.id,
        note,
      },
    });
    await settleStorefrontReservations(tx, storeId, current, toStatus);
    // Phase 15: the notification row commits or rolls back with the transition itself.
    // ق-214: the actor rides along, so the shop is not mailed about its own click.
    await enqueueOrderStatusChanged(tx, {
      storeId,
      orderId,
      orderNumber: current.orderNumber,
      fromStatus,
      toStatus,
      customerEmail: current.customerEmail,
      actorKind: actor.kind,
    });
    // CD-1b: the courier-on-the-way notice rides the SAME transaction as the
    // transition that produced it. Only this one edge fires it, and the dedupe
    // key makes a repeat structurally impossible.
    if (toStatus === "out_for_delivery") {
      await enqueueCourierDispatched(tx, {
        storeId,
        orderId,
        orderNumber: current.orderNumber,
        customerEmail: current.customerEmail,
      });
    }
    // Phase 17: the financial ledger rides the same transaction — completion books the
    // commission snapshot; a return reverses it automatically inside the approved window.
    if (toStatus === "completed") {
      // Phase 20B-1 (approved decision §8.4): the commission books on the
      // DISCOUNTED subtotal — ledger.subtotal_iqd means "commissionable net".
      // The return reversal copies the completion entry, so it is symmetric
      // automatically.
      // 19-د: the points the shopper redeemed ride the SAME entry. He handed the
      // courier `subtotal − coupon − points + delivery`; without this field the
      // ledger described a sale nobody paid for in full and the wallet paid the
      // merchant the difference.
      //
      // The commissionable net stays `subtotalIqd - discountIqd`. That is an
      // OWNER DECISION of 2026-09-04, asked and answered «لا»: a coupon reduces
      // the commission base, redeemed points do not, because points are a debt
      // the merchant sold himself on an earlier order. Loyalty is therefore
      // carried as its own deduction on the entry and subtracted in the payout,
      // never folded into the base here. See `recordOrderCompletion`.
      // Marketplace M8b: the platform coupon rides the entry for the record only —
      // the platform's cost. It is in neither the commission base nor the payout's
      // deductions: the store is paid as if the shopper had paid it.
      await recordOrderCompletion(tx, {
        storeId,
        orderId,
        subtotalIqd: current.subtotalIqd - current.discountIqd,
        deliveryFeeIqd: current.deliveryFeeIqd,
        loyaltyDiscountIqd: current.loyaltyDiscountIqd,
        platformDiscountIqd: current.platformDiscountIqd,
      });
      // CD-5: points are decided in the SAME transaction as the money, on what
      // the shopper actually paid IN MONEY for goods — subtotal less the coupon
      // AND less any points he redeemed. Awarding on the pre-redemption figure
      // would pay him points for the part his own points covered, making every
      // redemption partly self-funding.
      //
      // Note this is deliberately a SMALLER base than the commissionable net the
      // ledger books: the merchant's commission is charged on the sale, and the
      // shopper's reward is earned on his spending. They are different questions
      // about the same order.
      const paidGoodsIqd =
        current.subtotalIqd -
        current.discountIqd -
        current.loyaltyDiscountIqd -
        current.platformDiscountIqd;
      await awardLoyaltyPoints(tx, {
        storeId,
        orderId,
        customerId: current.customerId ?? null,
        subtotalIqd: paidGoodsIqd,
      });
      // Marketplace M8b: the platform's points, on the same money-paid base, once per order.
      await awardPlatformPoints(tx, {
        orderId,
        customerId: current.customerId ?? null,
        paidGoodsIqd,
      });
      // Marketplace M9: and extra spins on the prize wheel, on the same base, once per order.
      await grantWheelSpins(tx, {
        orderId,
        customerId: current.customerId ?? null,
        paidGoodsIqd,
      });
    } else if (toStatus === "returned") {
      await recordOrderReturn(tx, { storeId, orderId });
      // CD-5: both sides. Without the clawback, buy → return prints points;
      // without the refund, points spent on a returned order are simply kept.
      await reverseLoyaltyForReturn(tx, { storeId, orderId });
      // Marketplace M8b: and the platform's points too. The coupon is not given back — it was used.
      await clawbackPlatformPoints(tx, orderId);
      await revokeWheelSpins(tx, orderId);
    } else if (toStatus === "cancelled" || toStatus === "rejected") {
      // ق-191 — the order dies before it is paid, and the points must come back.
      //
      // `commitLoyaltyRedemption` writes the `spent` row at CHECKOUT, on an order
      // that is still `new`. Until now the only refund writer was the branch
      // above, so a shopper whose order was cancelled — by the merchant, by a
      // bulk action, or by himself from his own order page — silently lost every
      // point he had redeemed on it. He paid nothing, received nothing, and the
      // points were gone: the platform kept value it never delivered against.
      //
      // The SAME function serves, because it was written «deliberately tolerant
      // of missing halves». A cancelled order carries no `earned` row — the
      // award only ever happens on `completed`, and the transition table above
      // lets `completed` reach only `returned` — so here it writes the refund
      // alone. Should that table ever admit `completed → cancelled`, the
      // clawback this same call would then also write is already correct.
      //
      // No ledger call sits beside it on purpose: nothing was ever booked for an
      // order that did not complete, so there is nothing to reverse. The money
      // side and the points side are independent here, which is why the defect
      // could hide — the money path was correct.
      await reverseLoyaltyForReturn(tx, { storeId, orderId });
      // Marketplace M8b: an order that died before it was paid gives the platform coupon back.
      await releasePlatformCoupon(tx, orderId);
    }
    const updated = await tx.storeOrder.findFirst({
      where: { id: orderId, storeId },
      include: orderInclude,
    });
    if (!updated)
      throw new HttpError(
        500,
        "ORDER_TRANSITION_FAILED",
        "Order transition could not be completed."
      );
    return orderPayload(updated);
  });
  // After commit: extension modules react without the state machine knowing them.
  domainEvents.emit("order.status_changed", {
    storeId,
    orderId,
    orderNumber: payload.orderNumber,
    from: fromStatusForEvent,
    to: toStatus,
    actorKind: actor.kind,
  });
  return payload;
}

export async function listPlatformOrders(query: Record<string, unknown>) {
  const limit = parseListLimit(query.limit);
  const cursor = await orderCursor(PLATFORM_ORDERS_KIND, query.cursor);
  const status =
    query.status === undefined || query.status === ""
      ? undefined
      : orderStatus(query.status, "INVALID_ORDER_STATUS_FILTER");
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined;
  const merchantId =
    typeof query.merchantId === "string" && query.merchantId ? query.merchantId : undefined;
  const storeSlug =
    typeof query.storeSlug === "string" && query.storeSlug ? query.storeSlug : undefined;
  // PG-6: the same widening as the merchant list, cross-tenant by design —
  // `searchPlatformOrders` is a separate engine method with no storeId to omit.
  const where: Prisma.StoreOrderWhereInput = {
    ...(status ? { status } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    ...(q ? { id: { in: await orderSearchIds(null, q) } } : {}),
    ...(storeSlug || merchantId
      ? {
          store: {
            ...(storeSlug ? { slug: storeSlug } : {}),
            ...(merchantId ? { merchantId } : {}),
          },
        }
      : {}),
    ...keysetWhere("createdAt", "desc", cursor),
  };
  const rows = await prisma.storeOrder.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      store: {
        select: { slug: true, name: true, merchant: { select: { id: true, businessName: true } } },
      },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(PLATFORM_ORDERS_KIND, last.createdAt, last.id)
  );
  return { orders: page.map(orderPayload), nextCursor };
}

export async function platformOrder(orderId: string) {
  const order = await prisma.storeOrder.findUnique({
    where: { id: orderId },
    include: orderInclude,
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");
  return orderPayload(order);
}
