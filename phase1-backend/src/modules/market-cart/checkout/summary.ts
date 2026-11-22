/**
 * Market checkout — summary. Split verbatim from checkout.service.ts (review batch 2, ت-١٢);
 * checkout.service.ts re-exports what it always exported.
 */
import { listedStoreTenant } from "../../market-stores/directory.service.js";
import { marketCartView } from "../cart.service.js";
import { prisma } from "../../../db/prisma.js";
import { enabledPaymentMethods } from "../../../services/payment-methods.service.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { governorateLabel } from "../../../services/governorates.js";
import { previewCoupon } from "../../../services/coupon.service.js";
import { applicableCoupons } from "../../market-rewards/rewards.service.js";
import { onlineOptions } from "../../market-payments/payments.service.js";
import { type ShopperRef, shopperAddress } from "./customer.js";

/** Marketplace M13a: what an instalment plan covers — the goods after both coupons; the delivery fee is paid in cash. */
export async function goodsToCover(
  shopper: ShopperRef,
  storeSlug: string,
  input: {
    addressId?: string | null;
    fulfilment: "delivery" | "pickup";
    couponCode?: string | null;
    platformCouponWalletId?: string | null;
  }
) {
  const summary = await checkoutSummary(shopper, storeSlug, {
    addressId: input.addressId ?? undefined,
    fulfilment: input.fulfilment,
    coupon: input.couponCode ?? undefined,
    platformCoupon: input.platformCouponWalletId ?? undefined,
  });
  return summary.subtotalIqd - summary.discountIqd - summary.platformDiscountIqd;
}

/** What paying this store would cost, before committing to it. Advisory: checkout re-decides everything under lock. */
export async function checkoutSummary(
  shopper: ShopperRef,
  storeSlug: string,
  input: {
    addressId?: string;
    fulfilment: "delivery" | "pickup";
    coupon?: string;
    platformCoupon?: string;
  }
) {
  const store = await listedStoreTenant(storeSlug);
  const [view, storeRow, methods, anyRate] = await Promise.all([
    marketCartView(shopper.id, store.id),
    prisma.store.findUniqueOrThrow({
      where: { id: store.id },
      select: {
        name: true,
        pickupEnabled: true,
        addressLine: true,
        latitude: true,
        longitude: true,
        governorateKey: true,
      },
    }),
    enabledPaymentMethods(prisma, store.id),
    prisma.deliveryRate.findFirst({
      where: { storeId: store.id, isEnabled: true },
      select: { id: true },
    }),
  ]);
  const group = view.stores[0];
  if (!group) throw new HttpError(422, "CART_EMPTY", "لا توجد منتجات من هذا المتجر في سلتك.");
  let delivery: { available: boolean; amountIqd: number | null; reason: string | null } = {
    available: true,
    amountIqd: 0,
    reason: null,
  };
  if (input.fulfilment === "pickup") {
    if (!storeRow.pickupEnabled)
      delivery = {
        available: false,
        amountIqd: null,
        reason: "هذا المتجر لا يتيح الاستلام من المتجر.",
      };
  } else if (!anyRate) {
    delivery = {
      available: false,
      amountIqd: null,
      reason: "هذا المتجر لم يحدّد رسوم التوصيل بعد.",
    };
  } else if (input.addressId) {
    const address = await shopperAddress(shopper.id, input.addressId);
    const rate = await prisma.deliveryRate.findUnique({
      where: { storeId_governorate: { storeId: store.id, governorate: address.governorateKey } },
      select: { amountIqd: true, isEnabled: true },
    });
    delivery = rate?.isEnabled
      ? { available: true, amountIqd: rate.amountIqd, reason: null }
      : {
          available: false,
          amountIqd: null,
          reason: `هذا المتجر لا يوصّل إلى ${governorateLabel(address.governorateKey)} حالياً.`,
        };
  } else {
    delivery = { available: false, amountIqd: null, reason: "اختر عنوان التوصيل." };
  }
  let coupon:
    | { code: string; discountIqd: number; freeShipping: boolean }
    | { error: string }
    | null = null;
  if (input.coupon) {
    const customer = await prisma.customer.findFirst({
      where: { storeId: store.id, shopperId: shopper.id },
      select: { id: true },
    });
    try {
      const preview = await previewCoupon(store.id, customer?.id, input.coupon, group.subtotalIqd);
      coupon = {
        code: preview.code,
        discountIqd: preview.discountIqd,
        freeShipping: preview.freeShipping,
      };
    } catch (error) {
      coupon = {
        error:
          error instanceof HttpError
            ? "الكوبون غير صالح لهذا المتجر. تأكّد من الرمز وحاول مجدداً."
            : "تعذّر التحقق من الكوبون.",
      };
    }
  }
  const discount = coupon && "discountIqd" in coupon ? coupon.discountIqd : 0;
  const fee = delivery.available
    ? coupon && "freeShipping" in coupon && coupon.freeShipping
      ? 0
      : (delivery.amountIqd ?? 0)
    : 0;
  // Marketplace M8b: the platform coupons he holds that work here, on what is left after the store's coupon.
  const platformCoupons = await applicableCoupons(
    shopper.id,
    store.id,
    group.subtotalIqd - discount
  );
  const chosen = input.platformCoupon
    ? (platformCoupons.find((entry) => entry.walletId === input.platformCoupon && entry.usable) ??
      null)
    : null;
  const platformDiscount = chosen?.discountIqd ?? 0;
  return {
    storeSlug: store.slug,
    store: {
      name: storeRow.name,
      pickupEnabled: storeRow.pickupEnabled,
      location:
        storeRow.latitude !== null
          ? {
              latitude: storeRow.latitude,
              longitude: storeRow.longitude,
              addressLine: storeRow.addressLine,
            }
          : null,
    },
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
    paymentMethods: methods.map((method) => ({
      code: method.code,
      displayName: method.displayName,
      kind: method.kind,
    })),
    // Marketplace M13a: the market's online methods, when a provider is on.
    online: await onlineOptions(shopper, store.id, group.subtotalIqd - discount - platformDiscount),
  };
}
