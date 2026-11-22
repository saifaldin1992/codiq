/**
 * Market checkout — place. Split verbatim from checkout.service.ts (review batch 2, ت-١٢);
 * checkout.service.ts re-exports what it always exported.
 */
import { listedStoreTenant } from "../../market-stores/directory.service.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { paymentsMode } from "../../market-payments/providers.js";
import { priorSucceededCheckout, checkout } from "../../../services/storefront.service.js";
import { prisma } from "../../../db/prisma.js";
import {
  confirmInstalmentPlan,
  abandonInstalmentPlan,
  attachInstalmentPlan,
  openCardSession,
} from "../../market-payments/payments.service.js";
import { ensureHandoverCode } from "../../market-orders/after-sales.service.js";
import { transitionOrderStatus } from "../../../services/order-lifecycle.service.js";
import { repriceMarketLines } from "../cart.service.js";
import { type ShopperRef, shopperAddress, customerForShopper } from "./customer.js";
import { goodsToCover } from "./summary.js";

export async function placeMarketOrder(
  shopper: ShopperRef,
  storeSlug: string,
  input: {
    addressId: string;
    fulfilment: "delivery" | "pickup";
    paymentMethodCode: string;
    couponCode?: string | null;
    note?: string | null;
    platformCouponWalletId?: string | null;
    instalmentPaymentId?: string | null;
    instalmentCode?: string | null;
  },
  idempotencyKey: unknown,
  options: { paidByPartner?: boolean } = {}
) {
  const store = await listedStoreTenant(storeSlug);
  // Marketplace M13a: an online method is the market's, not the store's.
  const marketPayment =
    input.paymentMethodCode === "market_card"
      ? ("card" as const)
      : input.paymentMethodCode === "market_instalments"
        ? ("instalments" as const)
        : input.paymentMethodCode === "market_partner"
          ? ("partner" as const)
          : undefined;
  // M13b: «paid by the partner» is said only by the partner's signed call, never by the shopper's request.
  if (marketPayment === "partner" && !options.paidByPartner)
    throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "وسيلة الدفع غير مدعومة.");
  if ((marketPayment === "card" || marketPayment === "instalments") && paymentsMode() === "off")
    throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "الدفع الإلكترونيّ غير متاح الآن.");
  const address = await shopperAddress(shopper.id, input.addressId);
  const customerId = await customerForShopper(store.id, shopper, address.recipientName);

  // A repeated tap with the same key is the same order, whatever the cart now holds.
  const prior = await priorSucceededCheckout(store.id, customerId, idempotencyKey);
  if (prior) return { replayed: true, order: prior };

  const cart = await prisma.marketCart.findUnique({
    where: { shopperId: shopper.id },
    select: { id: true },
  });
  const lines = cart
    ? await prisma.marketCartItem.findMany({
        where: { cartId: cart.id, storeId: store.id },
        orderBy: { createdAt: "asc" },
      })
    : [];
  if (!lines.length)
    throw new HttpError(422, "CART_EMPTY", "لا توجد منتجات من هذا المتجر في سلتك.");

  // Move the lines into the shopper's own cart at this store, replacing whatever it held.
  const storeCartVersion = await prisma.$transaction(async (tx) => {
    const existing = await tx.shoppingCart.findFirst({
      where: { storeId: store.id, customerId, ownerKind: "customer", status: "active" },
      select: { id: true },
    });
    const storeCart =
      existing ??
      (await tx.shoppingCart.create({
        data: { storeId: store.id, customerId, ownerKind: "customer", status: "active" },
        select: { id: true },
      }));
    await tx.cartItem.deleteMany({ where: { cartId: storeCart.id, storeId: store.id } });
    await tx.cartItem.createMany({
      data: lines.map((line) => ({
        cartId: storeCart.id,
        storeId: store.id,
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        priceSnapshotIqd: line.priceSnapshotIqd,
        addonIds: line.addonIds,
        addonsSnapshotIqd: line.addonsSnapshotIqd,
      })),
    });
    const bumped = await tx.shoppingCart.update({
      where: { id: storeCart.id },
      data: { version: { increment: 1 }, lastActivityAt: new Date() },
      select: { version: true },
    });
    return bumped.version;
  });

  // Instalments: the lender's code approves the plan BEFORE the order is placed, on the goods it will cover.
  let plan: { id: string; amountIqd: number } | null = null;
  if (marketPayment === "instalments") {
    const goods = await goodsToCover(shopper, storeSlug, input);
    plan = await confirmInstalmentPlan(
      shopper,
      store.id,
      input.instalmentPaymentId,
      input.instalmentCode,
      goods
    );
  }

  // The alternate number reaches the store on the order itself, where the courier reads it.
  const extra = [
    address.altPhoneNormalized ? `رقم بديل: 0${address.altPhoneNormalized.slice(4)}` : null,
    input.note?.trim() || null,
  ]
    .filter(Boolean)
    .join(" — ");
  try {
    const result = await checkout(store.id, customerId, {
      idempotencyKey,
      cartVersion: storeCartVersion,
      address: {
        recipientName: address.recipientName,
        fullAddress: `${address.district.nameAr} — ${address.addressLine}`,
        city: address.district.nameAr,
        governorate: address.governorateKey,
        phoneContact: address.phoneNormalized,
      },
      paymentMethodCode: input.paymentMethodCode,
      couponCode: input.couponCode ?? undefined,
      note: extra || undefined,
      fulfilment: input.fulfilment,
      platformCouponWalletId: input.platformCouponWalletId ?? undefined,
      marketPayment,
    });
    // The shopper's receipt code, issued with the order (idempotent on a replay).
    await ensureHandoverCode(result.order.id, store.id);
    // Bought: those lines leave the market cart. Lines added meanwhile stay.
    const bought = new Set(result.order.items.map((item) => item.variantId));
    if (cart) {
      await prisma.marketCartItem.deleteMany({
        where: {
          cartId: cart.id,
          storeId: store.id,
          variantId: { in: Array.from(bought).filter((id): id is string => Boolean(id)) },
        },
      });
      await prisma.marketCart.update({
        where: { id: cart.id },
        data: { version: { increment: 1 } },
      });
    }
    if (plan) {
      const order = result.order;
      const covered =
        order.subtotalIqd -
        order.discountIqd -
        order.loyaltyDiscountIqd -
        order.platformDiscountIqd;
      if (covered !== plan.amountIqd) {
        await transitionOrderStatus(store.id, { kind: "system", id: plan.id }, order.id, {
          toStatus: "cancelled",
          expectedVersion: order.version,
          note: "تغيّر مبلغ التقسيط.",
        }).catch(() => undefined);
        await abandonInstalmentPlan(plan.id);
        throw new HttpError(
          422,
          "INSTALMENT_AMOUNT_CHANGED",
          "تغيّر مبلغ الطلب منذ اخترت التقسيط — اختر المدّة من جديد."
        );
      }
      await attachInstalmentPlan(plan.id, order.id);
    }
    const payment =
      marketPayment === "card"
        ? await openCardSession(
            {
              id: result.order.id,
              storeId: store.id,
              totalIqd: result.order.totalIqd,
              orderNumber: result.order.orderNumber,
              version: result.order.version,
            },
            shopper.id
          )
        : null;
    return { replayed: result.replayed, order: result.order, ...(payment ? { payment } : {}) };
  } catch (error) {
    if (plan) await abandonInstalmentPlan(plan.id).catch(() => undefined);
    if (error instanceof HttpError && error.code === "CART_PRICE_CHANGED")
      await repriceMarketLines(shopper.id, store.id);
    throw error;
  }
}
