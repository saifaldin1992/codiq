/**
 * Paying for one store's lines of the market cart.
 *
 * THE WHOLE TRICK: the store's lines are moved into the shopper's own customer
 * cart AT THAT STORE, and the store's existing `checkout()` runs unchanged —
 * the same serializable transaction, variant locks, stock reservations, coupon
 * lock order, loyalty, commission, ledger, notification and domain event as a
 * purchase made on the storefront. The market adds no money logic of its own.
 *
 * The shopper becomes a customer of the store on his first order there: a
 * customers row with shopper_id set (or, if the store already knew his phone,
 * that existing row is linked — his phone is proven by the one-time code).
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { checkout, priorSucceededCheckout } from "../../services/storefront.service.js";
import { previewCoupon } from "../../services/coupon.service.js";
import { enabledPaymentMethods } from "../../services/payment-methods.service.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { governorateLabel } from "../../services/governorates.js";
import { listedStoreTenant } from "../market-stores/directory.service.js";
import { marketCartView, repriceMarketLines } from "./cart.service.js";
import { afterSalesState, ensureHandoverCode } from "../market-orders/after-sales.service.js";
import { applicableCoupons } from "../market-rewards/rewards.service.js";

type ShopperRef = { id: string; phoneNormalized: string; fullName: string | null };

async function shopperAddress(shopperId: string, addressId: string) {
  const address = await prisma.shopperAddress.findFirst({ where: { id: addressId, shopperId }, include: { district: { select: { nameAr: true } } } });
  if (!address) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
  return address;
}

/** The store's customer row for this shopper, created or linked on first use. */
export async function customerForShopper(storeId: string, shopper: ShopperRef, nameFallback: string) {
  const linked = await prisma.customer.findFirst({ where: { storeId, shopperId: shopper.id }, select: { id: true, isActive: true } });
  if (linked) {
    if (!linked.isActive) throw new HttpError(403, "CUSTOMER_DISABLED", "لا يمكنك الطلب من هذا المتجر حالياً. تواصل مع المتجر.");
    return linked.id;
  }
  const known = await prisma.customer.findFirst({ where: { storeId, phoneNormalized: shopper.phoneNormalized, shopperId: null, isGuest: false, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (known) {
    const claimed = await prisma.customer.updateMany({ where: { id: known.id, shopperId: null }, data: { shopperId: shopper.id } });
    if (claimed.count === 1) return known.id;
  }
  try {
    const created = await prisma.customer.create({ data: { storeId, shopperId: shopper.id, fullName: shopper.fullName ?? nameFallback, phoneNormalized: shopper.phoneNormalized, phoneVerifiedAt: new Date() }, select: { id: true } });
    return created.id;
  } catch (error) {
    // Two first orders at once: the other request created the row; use it.
    const raced = await prisma.customer.findFirst({ where: { storeId, shopperId: shopper.id }, select: { id: true } });
    if (raced) return raced.id;
    throw error;
  }
}

/** What paying this store would cost, before committing to it. Advisory: checkout re-decides everything under lock. */
export async function checkoutSummary(shopper: ShopperRef, storeSlug: string, input: { addressId?: string; fulfilment: "delivery" | "pickup"; coupon?: string; platformCoupon?: string }) {
  const store = await listedStoreTenant(storeSlug);
  const [view, storeRow, methods, anyRate] = await Promise.all([
    marketCartView(shopper.id, store.id),
    prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { name: true, pickupEnabled: true, addressLine: true, latitude: true, longitude: true, governorateKey: true } }),
    enabledPaymentMethods(prisma, store.id),
    prisma.deliveryRate.findFirst({ where: { storeId: store.id, isEnabled: true }, select: { id: true } }),
  ]);
  const group = view.stores[0];
  if (!group) throw new HttpError(422, "CART_EMPTY", "لا توجد منتجات من هذا المتجر في سلتك.");
  let delivery: { available: boolean; amountIqd: number | null; reason: string | null } = { available: true, amountIqd: 0, reason: null };
  if (input.fulfilment === "pickup") {
    if (!storeRow.pickupEnabled) delivery = { available: false, amountIqd: null, reason: "هذا المتجر لا يتيح الاستلام من المتجر." };
  } else if (!anyRate) {
    delivery = { available: false, amountIqd: null, reason: "هذا المتجر لم يحدّد رسوم التوصيل بعد." };
  } else if (input.addressId) {
    const address = await shopperAddress(shopper.id, input.addressId);
    const rate = await prisma.deliveryRate.findUnique({ where: { storeId_governorate: { storeId: store.id, governorate: address.governorateKey } }, select: { amountIqd: true, isEnabled: true } });
    delivery = rate?.isEnabled ? { available: true, amountIqd: rate.amountIqd, reason: null } : { available: false, amountIqd: null, reason: `هذا المتجر لا يوصّل إلى ${governorateLabel(address.governorateKey)} حالياً.` };
  } else {
    delivery = { available: false, amountIqd: null, reason: "اختر عنوان التوصيل." };
  }
  let coupon: { code: string; discountIqd: number; freeShipping: boolean } | { error: string } | null = null;
  if (input.coupon) {
    const customer = await prisma.customer.findFirst({ where: { storeId: store.id, shopperId: shopper.id }, select: { id: true } });
    try {
      const preview = await previewCoupon(store.id, customer?.id, input.coupon, group.subtotalIqd);
      coupon = { code: preview.code, discountIqd: preview.discountIqd, freeShipping: preview.freeShipping };
    } catch (error) {
      coupon = { error: error instanceof HttpError ? "الكوبون غير صالح لهذا المتجر. تأكّد من الرمز وحاول مجدداً." : "تعذّر التحقق من الكوبون." };
    }
  }
  const discount = coupon && "discountIqd" in coupon ? coupon.discountIqd : 0;
  const fee = delivery.available ? (coupon && "freeShipping" in coupon && coupon.freeShipping ? 0 : delivery.amountIqd ?? 0) : 0;
  // Marketplace M8b: the platform coupons he holds that work here, on what is left after the store's coupon.
  const platformCoupons = await applicableCoupons(shopper.id, store.id, group.subtotalIqd - discount);
  const chosen = input.platformCoupon ? platformCoupons.find((entry) => entry.walletId === input.platformCoupon && entry.usable) ?? null : null;
  const platformDiscount = chosen?.discountIqd ?? 0;
  return {
    storeSlug: store.slug,
    store: { name: storeRow.name, pickupEnabled: storeRow.pickupEnabled, location: storeRow.latitude !== null ? { latitude: storeRow.latitude, longitude: storeRow.longitude, addressLine: storeRow.addressLine } : null },
    lines: group.lines,
    ready: group.ready,
    subtotalIqd: group.subtotalIqd,
    delivery,
    coupon,
    discountIqd: discount,
    platformCoupons,
    platformCoupon: chosen,
    platformDiscountIqd: platformDiscount,
    totalIqd: group.subtotalIqd - discount - platformDiscount + fee,
    paymentMethods: methods.map((method) => ({ code: method.code, displayName: method.displayName, kind: method.kind })),
  };
}

export async function placeMarketOrder(shopper: ShopperRef, storeSlug: string, input: { addressId: string; fulfilment: "delivery" | "pickup"; paymentMethodCode: string; couponCode?: string | null; note?: string | null; platformCouponWalletId?: string | null }, idempotencyKey: unknown) {
  const store = await listedStoreTenant(storeSlug);
  const address = await shopperAddress(shopper.id, input.addressId);
  const customerId = await customerForShopper(store.id, shopper, address.recipientName);

  // A repeated tap with the same key is the same order, whatever the cart now holds.
  const prior = await priorSucceededCheckout(store.id, customerId, idempotencyKey);
  if (prior) return { replayed: true, order: prior };

  const cart = await prisma.marketCart.findUnique({ where: { shopperId: shopper.id }, select: { id: true } });
  const lines = cart ? await prisma.marketCartItem.findMany({ where: { cartId: cart.id, storeId: store.id }, orderBy: { createdAt: "asc" } }) : [];
  if (!lines.length) throw new HttpError(422, "CART_EMPTY", "لا توجد منتجات من هذا المتجر في سلتك.");

  // Move the lines into the shopper's own cart at this store, replacing whatever it held.
  const storeCartVersion = await prisma.$transaction(async (tx) => {
    const existing = await tx.shoppingCart.findFirst({ where: { storeId: store.id, customerId, ownerKind: "customer", status: "active" }, select: { id: true } });
    const storeCart = existing ?? await tx.shoppingCart.create({ data: { storeId: store.id, customerId, ownerKind: "customer", status: "active" }, select: { id: true } });
    await tx.cartItem.deleteMany({ where: { cartId: storeCart.id, storeId: store.id } });
    await tx.cartItem.createMany({ data: lines.map((line) => ({ cartId: storeCart.id, storeId: store.id, productId: line.productId, variantId: line.variantId, quantity: line.quantity, priceSnapshotIqd: line.priceSnapshotIqd, addonIds: line.addonIds, addonsSnapshotIqd: line.addonsSnapshotIqd })) });
    const bumped = await tx.shoppingCart.update({ where: { id: storeCart.id }, data: { version: { increment: 1 }, lastActivityAt: new Date() }, select: { version: true } });
    return bumped.version;
  });

  // The alternate number reaches the store on the order itself, where the courier reads it.
  const extra = [address.altPhoneNormalized ? `رقم بديل: 0${address.altPhoneNormalized.slice(4)}` : null, input.note?.trim() || null].filter(Boolean).join(" — ");
  try {
    const result = await checkout(store.id, customerId, {
      idempotencyKey,
      cartVersion: storeCartVersion,
      address: { recipientName: address.recipientName, fullAddress: `${address.district.nameAr} — ${address.addressLine}`, city: address.district.nameAr, governorate: address.governorateKey, phoneContact: address.phoneNormalized },
      paymentMethodCode: input.paymentMethodCode,
      couponCode: input.couponCode ?? undefined,
      note: extra || undefined,
      fulfilment: input.fulfilment,
      platformCouponWalletId: input.platformCouponWalletId ?? undefined,
    });
    // The shopper's receipt code, issued with the order (idempotent on a replay).
    await ensureHandoverCode(result.order.id, store.id);
    // Bought: those lines leave the market cart. Lines added meanwhile stay.
    const bought = new Set(result.order.items.map((item) => item.variantId));
    if (cart) {
      await prisma.marketCartItem.deleteMany({ where: { cartId: cart.id, storeId: store.id, variantId: { in: Array.from(bought).filter((id): id is string => Boolean(id)) } } });
      await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
    }
    return { replayed: result.replayed, order: result.order };
  } catch (error) {
    if (error instanceof HttpError && error.code === "CART_PRICE_CHANGED") await repriceMarketLines(shopper.id, store.id);
    throw error;
  }
}

// ── طلباتي ───────────────────────────────────────────────────────────────────

const ORDERS_KIND = "market-shopper-orders";
const STATUS_LABELS: Record<string, string> = {
  new: "قيد المراجعة", processing: "تم القبول", preparation: "قيد التجهيز", out_for_delivery: "في الطريق إليك",
  completed: "تم التسليم", cancelled: "ملغي", rejected: "مرفوض", returned: "مُرجع",
};

/** Every order the shopper placed, across every store, newest first. */
export async function shopperOrders(shopperId: string, rawCursor: unknown, rawLimit: unknown, statusGroup: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(ORDERS_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const group = statusGroup === "active" ? { status: { in: ["new", "processing", "preparation", "out_for_delivery"] } } : statusGroup === "done" ? { status: { in: ["completed", "cancelled", "rejected", "returned"] } } : {};
  const rows = await prisma.storeOrder.findMany({
    where: { customer: { shopperId }, ...group, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, orderNumber: true, status: true, fulfilment: true, totalIqd: true, createdAt: true,
      store: { select: { slug: true, name: true } },
      items: { select: { productName: true, quantity: true }, take: 3 },
      _count: { select: { items: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(ORDERS_KIND, last.createdAt, last.id));
  return {
    orders: page.map((row) => ({ id: row.id, orderNumber: row.orderNumber, status: row.status, statusLabel: STATUS_LABELS[row.status] ?? row.status, fulfilment: row.fulfilment, totalIqd: row.totalIqd, createdAt: row.createdAt, store: row.store, itemCount: row._count.items, preview: row.items.map((item) => item.productName) })),
    nextCursor,
  };
}

export async function shopperOrder(shopperId: string, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, customer: { shopperId } },
    select: {
      id: true, storeId: true, orderNumber: true, status: true, statusUpdatedAt: true, fulfilment: true, deliveryStage: true, cancelReasonCode: true, createdAt: true, subtotalIqd: true, deliveryFeeIqd: true, discountIqd: true, loyaltyDiscountIqd: true, totalIqd: true,
      couponCode: true, paymentMethodCode: true, customerName: true, recipientPhone: true, shippingGovernorate: true, shippingAddressLine1: true, customerNote: true,
      store: { select: { slug: true, name: true, supportWhatsapp: true, addressLine: true, latitude: true, longitude: true } },
      items: { select: { id: true, productId: true, productName: true, variantName: true, quantity: true, unitPriceIqd: true, lineTotalIqd: true, addons: true } },
      statusEvents: { select: { toStatus: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const { storeId: _storeId, deliveryStage: _stage, cancelReasonCode: _reason, ...shown } = order;
  return {
    afterSales: await afterSalesState(order),
    order: {
      ...shown,
      statusLabel: STATUS_LABELS[order.status] ?? order.status,
      governorateName: order.shippingGovernorate ? governorateLabel(order.shippingGovernorate) : null,
      timeline: order.statusEvents.map((event) => ({ status: event.toStatus, label: STATUS_LABELS[event.toStatus] ?? event.toStatus, at: event.createdAt })),
    },
  };
}
