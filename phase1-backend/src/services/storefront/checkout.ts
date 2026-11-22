/**
 * Storefront — checkout. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
import {
  normalizeCouponCode,
  lockCouponForCheckout,
  computeCouponDiscount,
} from "../coupon.service.js";
import { prisma } from "../../db/prisma.js";
import {
  SERIALIZABLE_ATTEMPTS,
  isRetryableTransactionError,
  sleepBeforeRetry,
} from "../../db/serializable-retry.js";
import { effectiveStoreState } from "../availability.service.js";
import { assertWithinPlanLimit } from "../entitlement.service.js";
import { toGovernorateKey } from "../governorates.js";
import { paymentMethodForCheckout } from "../payment-methods.service.js";
import { previewLoyaltyRedemption, commitLoyaltyRedemption } from "../loyalty.service.js";
import {
  lockPlatformCouponForCheckout,
  markPlatformCouponUsed,
} from "../platform-rewards.service.js";
import { enqueueOrderCreated } from "../../notifications/notification-outbox.service.js";
import { domainEvents } from "../../events/domain-events.js";
import {
  type CheckoutInput,
  hash,
  idempotencyKey,
  expectedCartVersion,
  CART_STATUS_ACTIVE,
} from "./shared.js";
import { addressForCheckout, deliveryRateForGovernorate } from "./addresses.js";

/**
 * PG-5 (ق-73) — what the customer asks for at checkout: «اتصل قبل الوصول»,
 * «هدية، لا تضع الفاتورة», «الشقة فوق الصيدلية». Daily requests in this market,
 * and today he has nowhere to put them — so he calls, or the courier arrives to
 * a locked door.
 *
 * Absent and empty are the SAME thing here (null), so a customer who opens the
 * field and types nothing is not different from one who never opened it. That
 * matters for the fingerprint below.
 */
export function normalizeCustomerNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new HttpError(422, "INVALID_ORDER_NOTE", "الملاحظة يجب أن تكون نصاً.");
  const note = value.trim();
  if (!note) return null;
  if (note.length > 500)
    throw new HttpError(422, "INVALID_ORDER_NOTE", "الملاحظة يجب ألا تتجاوز 500 حرف.");
  return note;
}

/**
 * Phase 20B-1: the normalized coupon code joins the fingerprint CONDITIONALLY —
 * the key is entirely ABSENT when no coupon is sent, so every fingerprint
 * computed before this deploy stays byte-identical (idempotent replays of
 * pre-deploy checkouts keep matching). A different coupon under the same
 * idempotency key therefore yields IDEMPOTENCY_KEY_REUSED.
 * Exported for the phase 20B-1 fingerprint unit assertions.
 */
export function checkoutFingerprint(input: CheckoutInput, cartVersion: number) {
  const couponCode = normalizeCouponCode(input.couponCode);
  // PG-5: the note joins CONDITIONALLY, exactly as the coupon code does — the
  // key is absent when no note is sent, so every fingerprint computed before
  // this deploy stays byte-identical and pre-deploy replays keep matching.
  //
  // ⚠️ A deliberate reading of the plan. Its acceptance criterion says the note
  // must be stored «بلا مساس ببصمة idempotency», which taken literally would
  // leave the note OUT. Its stated purpose is that existing fingerprints must not
  // break — and conditional inclusion achieves exactly that, which is why 20B-1
  // chose it for the coupon. Leaving the note out instead would mean a retry
  // carrying a DIFFERENT note silently returns the original order with the
  // original note: the customer would see his correction accepted and the
  // merchant would never receive it. Answering IDEMPOTENCY_KEY_REUSED is the
  // honest response to a genuinely different request.
  const note = normalizeCustomerNote(input.note);
  // CD-5: joins CONDITIONALLY, for the same reason the coupon and the note do —
  // a fingerprint computed before this deploy stays byte-identical, so replays
  // of pre-deploy checkouts keep matching. And a retry that redeems a DIFFERENT
  // number of points is a genuinely different request: answering
  // IDEMPOTENCY_KEY_REUSED is honest, where silently returning the original
  // order would spend points the shopper did not agree to spend this time.
  const loyaltyPoints =
    Number.isInteger(Number(input.loyaltyPoints)) && Number(input.loyaltyPoints) > 0
      ? Number(input.loyaltyPoints)
      : 0;
  // Marketplace M5: pick-up joins CONDITIONALLY too — delivery, the default, leaves every earlier fingerprint unchanged.
  const pickup = input.fulfilment === "pickup";
  // Marketplace M8b: a platform coupon joins CONDITIONALLY, like every term before it.
  const platformCoupon =
    typeof input.platformCouponWalletId === "string" && input.platformCouponWalletId
      ? input.platformCouponWalletId
      : null;
  return hash(
    JSON.stringify({
      cartVersion,
      addressId: typeof input.addressId === "string" ? input.addressId : null,
      address: input.address ?? null,
      paymentMethodCode: input.paymentMethodCode ?? "cod",
      ...(couponCode ? { couponCode } : {}),
      ...(note ? { note } : {}),
      ...(loyaltyPoints ? { loyaltyPoints } : {}),
      ...(pickup ? { fulfilment: "pickup" } : {}),
      ...(platformCoupon ? { platformCoupon } : {}),
    })
  );
}

/**
 * What an order's payment status is the moment it is placed (review batch 2, ر-٢ — this
 * was a five-level nested condition inside the order write).
 *   - a manual transfer waits for the merchant to confirm it;
 *   - the market's card waits for the gateway's signed notification;
 *   - the market's instalments are covered by the lender (delivery is cash);
 *   - the partner app has already taken the money;
 *   - everything else (cash at the door) is unpaid until delivery.
 */
const MARKET_PAYMENT_STATUS: Record<string, string> = {
  market_card: "awaiting_payment",
  market_instalments: "instalments",
  market_partner: "paid",
};

function initialPaymentStatus(method: { kind: string; code: string }): string {
  if (method.kind === "manual_transfer") return "awaiting_transfer";
  return MARKET_PAYMENT_STATUS[method.code] ?? "unpaid";
}

function orderNumber() {
  return `SF-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** ق-221 — one refused cart line, in the words the shopper needs to fix it. */
export interface RefusedCartLine {
  cartItemId: string;
  variantId: string;
  productName: string | null;
  /** null for the default variant, which has no name a shopper would recognise. */
  variantName: string | null;
  requested: number;
  available: number;
  /** `order_limit`: the merchant caps this product per order (Marketplace M2); `available` is the cap. */
  reason: "unavailable" | "insufficient_stock" | "order_limit";
}

function refusedLine(
  item: { id: string; variantId: string; quantity: number },
  variant: { productName: string; name: string; isDefault: boolean } | undefined,
  reason: RefusedCartLine["reason"],
  available: number
): RefusedCartLine {
  return {
    cartItemId: item.id,
    variantId: item.variantId,
    productName: variant?.productName ?? null,
    variantName: variant && !variant.isDefault ? variant.name : null,
    requested: item.quantity,
    available,
    reason,
  };
}

/**
 * 19-د — internal signal, never an HTTP shape.
 *
 * The price check runs INSIDE the serializable transaction, because the only
 * price worth trusting is the one read under the same `FOR UPDATE` lock that
 * already guards the stock. But the correction it implies — writing the true
 * price back onto the cart — must survive, and that transaction is about to
 * roll back. So the transaction throws this, the retry loop recognises it, and
 * the correction plus the shopper-facing refusal happen outside.
 *
 * It is deliberately NOT an HttpError: `isRetryableTransactionError` must never
 * see it as a serialization failure and silently retry into the same refusal.
 */
export class CartPriceMoved extends Error {
  constructor(
    readonly cartId: string,
    readonly lines: { id: string; livePriceIqd: number; liveAddonsIqd: number }[]
  ) {
    super("CART_PRICE_CHANGED");
    this.name = "CartPriceMoved";
  }
}

/**
 * Writes the live price back onto the stale lines and bumps the cart version.
 *
 * This is what makes the refusal ACTIONABLE rather than a dead end (ق-132's
 * principle at the checkout button): the shopper is told the prices moved, and
 * the very next read of his cart shows what they moved to, so his second tap
 * confirms a number he has actually seen. Without it he would be refused,
 * re-read the same stale total, and be refused again.
 *
 * The version bump is the honest signal that the cart changed underneath him —
 * the client already refreshes and mints a new idempotency key on exactly that
 * class of refusal (`CART_VERSION_CONFLICT`).
 */
async function repriceStaleCartLines(
  storeId: string,
  cartId: string,
  lines: { id: string; livePriceIqd: number; liveAddonsIqd: number }[]
) {
  await prisma.$transaction(async (tx) => {
    for (const line of lines) {
      await tx.cartItem.updateMany({
        where: { id: line.id, cartId, storeId },
        data: { priceSnapshotIqd: line.livePriceIqd, addonsSnapshotIqd: line.liveAddonsIqd },
      });
    }
    await tx.shoppingCart.update({
      where: { id: cartId },
      data: { version: { increment: 1 }, lastActivityAt: new Date() },
    });
  });
}

/**
 * ق-201: the order an idempotency key already produced, or null. Guest checkout
 * asks this BEFORE merging the guest cart, because the merge bumps the cart
 * version the fingerprint below was computed with — a second tap on «تأكيد
 * الطلب» would otherwise read as different data under the same key.
 */
export async function priorSucceededCheckout(
  storeId: string,
  customerId: string,
  rawIdempotencyKey: unknown
) {
  const keyHash = hash(idempotencyKey(rawIdempotencyKey));
  const prior = await prisma.checkoutRequest.findUnique({
    where: { storeId_customerId_keyHash: { storeId, customerId, keyHash } },
    include: { order: { include: { items: true, statusEvents: true } } },
  });
  return prior?.status === "succeeded" && prior.order ? prior.order : null;
}

export async function checkout(storeId: string, customerId: string, input: CheckoutInput) {
  const cartVersion = expectedCartVersion(input.cartVersion);
  const rawKey = idempotencyKey(input.idempotencyKey);
  const keyHash = hash(rawKey);
  const couponCodeNormalized = normalizeCouponCode(input.couponCode);
  const fingerprint = checkoutFingerprint(input, cartVersion);
  let lastError: unknown;
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma
        .$transaction(
          async (tx) => {
            const prior = await tx.checkoutRequest.findUnique({
              where: { storeId_customerId_keyHash: { storeId, customerId, keyHash } },
              include: { order: { include: { items: true, statusEvents: true } } },
            });
            if (prior?.status === "succeeded" && prior.order) {
              if (prior.requestFingerprint !== fingerprint)
                throw new HttpError(
                  409,
                  "IDEMPOTENCY_KEY_REUSED",
                  "This idempotency key was used with different checkout data."
                );
              return { replayed: true, order: prior.order };
            }
            // MD-1: vacation mode refuses NEW checkouts only — browsing, the cart, and
            // idempotent replays of already-succeeded checkouts (returned above) stay
            // untouched. No money math or locking changes.
            //
            // KNOWN, ACCEPTED RACE (documented deliberately, not fixed). This read is
            // not serialized against `updateStoreVacation`: a checkout that reaches this
            // line microseconds before the merchant flips the switch commits, so the
            // merchant can see one extra order arrive right after turning vacation on.
            // It is benign — the failure mode is "one more order", never wrong money,
            // wrong stock, or a lost order — and closing it would mean locking the store
            // row inside the hot checkout path for every single checkout, for a window
            // measured in milliseconds. The merchant's own mental model ("orders already
            // in flight still land") matches the behaviour.
            // ق-249: the named status decides; `paused` keeps the MD-1 answer word for word.
            // One read of the store for the whole checkout: its status here, its owner for
            // the plan limit, and whether it offers pick-up (review batch 2, ت-١).
            const gateRow = await tx.store.findFirst({
              where: { id: storeId },
              select: {
                id: true,
                status: true,
                statusMessage: true,
                maintenanceUntil: true,
                merchantId: true,
                pickupEnabled: true,
              },
            });
            // ق-250: the same clock the shell reads — a window that began refuses checkout with its own sentence.
            const gate = gateRow ? await effectiveStoreState(gateRow, new Date(), tx) : null;
            if (gate?.status === "paused")
              throw new HttpError(
                422,
                "STORE_ON_VACATION",
                "المتجر في إجازة مؤقتة ولا يستقبل طلبات جديدة حالياً."
              );
            if (gate?.status === "maintenance")
              throw new HttpError(
                423,
                "STORE_IN_MAINTENANCE",
                gate.message?.trim() || "المتجر مغلق للصيانة.",
                { until: gate.until?.toISOString() ?? null }
              );
            if (gate && gate.status !== "active")
              throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
            if (prior && prior.requestFingerprint !== fingerprint)
              throw new HttpError(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "This idempotency key was used with different checkout data."
              );
            const request =
              prior ??
              (await tx.checkoutRequest.create({
                data: {
                  storeId,
                  customerId,
                  keyHash,
                  requestFingerprint: fingerprint,
                  status: "processing",
                },
              }));
            const cart = await tx.shoppingCart.findFirst({
              where: { storeId, customerId, ownerKind: "customer", status: CART_STATUS_ACTIVE },
              include: { items: true },
            });
            if (!cart)
              throw new HttpError(
                409,
                "CART_ALREADY_CHECKED_OUT",
                "No active customer cart is available for checkout."
              );
            if (cart.version !== cartVersion)
              throw new HttpError(
                409,
                "CART_VERSION_CONFLICT",
                "The cart was changed by another request."
              );
            if (!cart.items.length) throw new HttpError(422, "CART_EMPTY", "Cart is empty.");
            // Phase 16: monthly order volume is a plan entitlement enforced server-side.
            //
            // ق-222 — CHECKED HERE, BEFORE ANY LOCK IS TAKEN. This used to run AFTER the
            // coupon row and every variant in the cart were locked FOR UPDATE, and
            // `merchantUsage` behind it fires six aggregates across every store the
            // merchant owns. Every millisecond a hot variant stays locked multiplies the
            // serialization retries of every other checkout on it — the Ramadan and
            // flash-sale pattern this platform will meet — until the six-attempt budget
            // runs out and a shopper sees TRANSACTION_CONTENTION. A read-only capacity
            // check belongs before the write locks, the same discipline the coupon
            // lock-order comment below applies to itself.
            if (!gateRow)
              throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
            // ق-216 — THE SHOPPER MUST NOT BE HANDED THE MERCHANT'S INVOICE.
            //
            // `assertWithinPlanLimit` throws 403 PLAN_LIMIT_EXCEEDED with a sentence
            // written for the merchant («تجاوزت حدّ خطتك… رقِّ اشتراكك»). Here the reader
            // is a stranger standing at the checkout of a shop that has hit its plan's
            // monthly order ceiling: he is told to upgrade a subscription he does not
            // have, and given no way forward. And this fires on the FIRST merchant who
            // succeeds — the 201st order of a good month — which is the merchant the
            // platform can least afford to lose. So the audience is split at the throw:
            // the shopper is told, in his own terms, that the shop is not taking orders
            // right now and to contact it. What the merchant is told is his own screens'
            // job, and every one of them still reads the true reason.
            try {
              await assertWithinPlanLimit(tx, gateRow.merchantId, "max_monthly_orders");
            } catch (error) {
              if (error instanceof HttpError && error.code === "PLAN_LIMIT_EXCEEDED") {
                throw new HttpError(
                  409,
                  "STORE_NOT_ACCEPTING_ORDERS",
                  "المتجر لا يستقبل طلبات جديدة حالياً — تواصل مع المتجر."
                );
              }
              throw error;
            }
            const address = await addressForCheckout(tx, storeId, customerId, input);
            // Marketplace M5: a counter pick-up needs no courier — no rate, no fee — and
            // only a store that offers it (stores.pickup_enabled, which itself requires
            // the store's place on the map) may take one. The address still carries the
            // shopper's name and phone, which is how the store calls him to collect.
            const pickup = input.fulfilment === "pickup";
            if (
              input.fulfilment !== undefined &&
              input.fulfilment !== "pickup" &&
              input.fulfilment !== "delivery"
            )
              throw new HttpError(422, "INVALID_FULFILMENT", "طريقة الاستلام غير معروفة.");
            if (pickup) {
              if (!gateRow.pickupEnabled)
                throw new HttpError(
                  422,
                  "PICKUP_NOT_AVAILABLE",
                  "هذا المتجر لا يتيح الاستلام من المتجر."
                );
            }
            const deliveryRate = pickup
              ? {
                  governorate: toGovernorateKey(address.governorate) ?? address.governorate,
                  amountIqd: 0,
                }
              : await deliveryRateForGovernorate(tx, storeId, address.governorate);
            // ق-209: any method the merchant switched on — cash at the door, or a
            // manual wallet transfer he named. `undefined` still means cash.
            const paymentMethod = await paymentMethodForCheckout(
              tx,
              storeId,
              input.paymentMethodCode,
              input.marketPayment
            );
            // Phase 20B-1 — FIXED GLOBAL LOCK ORDER: the coupon row is locked FOR UPDATE
            // BEFORE the ordered variant locks below. Every checkout acquires locks in
            // the same coupon→variants sequence, so no deadlock is possible. The
            // exactly-one-last-use guarantee is load-bearing on SERIALIZABLE isolation
            // (SSI aborts the losing reader with 40001, which the retry loop converts
            // to a clean re-read); the row lock alone would NOT be enough — do not
            // lower the isolation level. No coupon sent → this line is a no-op and
            // the transaction is byte-identical to 20A.
            const coupon = couponCodeNormalized
              ? await lockCouponForCheckout(tx, storeId, customerId, couponCodeNormalized)
              : null;
            // Phase 20A: stock, price, and the FOR UPDATE lock live on the variant. The
            // JOIN locks the variant AND its parent product together (FOR UPDATE OF v, p)
            // so the parent's is_active is a lock-fresh read — a concurrent deactivation
            // either waits for this checkout or forces a serialization retry that sees it.
            // Phase 20B-1: requires_prescription rides this SAME lock query (the only
            // checkout read the prescription feature adds).
            // PG-2: the `deleted_at IS NULL` predicates below are REDUNDANT with the
            // `*_deleted_implies_inactive` CHECK constraints — a trashed row can never
            // be is_active — and they are written out anyway so the protection is
            // VISIBLE where it is used instead of implicit two files away. A missing
            // row here lands in the same 422 PRODUCT_UNAVAILABLE as a deactivated one,
            // which is exactly what a shopper checking out mid-delete must see.
            const variantIds = [...cart.items.map((item) => item.variantId)].sort();
            // Marketplace M8a: `price_iqd` here is the LIVE price (codiq_live_price): the list
            // price, or an approved hourly deal's while its hour runs. A cart priced during
            // the hour and paid after it fails the snapshot check below and is re-priced.
            // 19-د: `v.price_iqd` joins the columns this lock already fetches. The price
            // that decides money must be read under the SAME lock as the stock that
            // decides availability — a price read outside it is a price that can move
            // between the read and the order.
            const lockedVariants = await tx.$queryRaw<
              Array<{
                id: string;
                product_id: string;
                sku: string;
                name: string;
                is_default: boolean;
                product_name: string;
                variant_active: boolean;
                product_active: boolean;
                requires_prescription: boolean;
                stock_quantity: number;
                price_iqd: number;
                max_per_order: number | null;
                is_preorder: boolean;
              }>
            >(Prisma.sql`
      SELECT v.id, v.product_id, v.sku, v.name, v.is_default, p.name AS product_name, v.is_active AS variant_active, p.is_active AS product_active, p.requires_prescription, v.stock_quantity, codiq_live_price(v.product_id, v.price_iqd, now()) AS price_iqd, p.max_per_order, p.is_preorder
      FROM product_variants v
      JOIN products p ON p.id = v.product_id AND p.store_id = v.store_id
      WHERE v.store_id = ${storeId}::uuid
        AND v.id IN (${Prisma.join(variantIds.map((variantId) => Prisma.sql`${variantId}::uuid`))})
        AND v.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY v.product_id ASC, v.id ASC
      FOR UPDATE OF v, p
    `);
            const variants = lockedVariants.map((variant) => ({
              id: variant.id,
              productId: variant.product_id,
              sku: variant.sku,
              name: variant.name,
              isDefault: variant.is_default,
              productName: variant.product_name,
              variantActive: variant.variant_active,
              productActive: variant.product_active,
              requiresPrescription: variant.requires_prescription,
              stockQuantity: variant.stock_quantity,
              priceIqd: variant.price_iqd,
              maxPerOrder: variant.max_per_order,
              isPreorder: variant.is_preorder,
            }));
            const variantById = new Map(variants.map((variant) => [variant.id, variant]));
            // ق-221 — THE REFUSAL NAMES THE LINE.
            //
            // «One or more cart products are unavailable» to a shopper with ten lines is
            // an instruction to fix something without being told what. A COD shopper
            // refused at the last step with nothing to act on does not edit his cart; he
            // closes the tab — there is no saved card pulling him back and no receipt
            // trail. So every refusal below carries `lines`: the product, the variant,
            // what he asked for and what is left, for EVERY offending line at once rather
            // than the first one found — the same shape `reorderIntoCart` already returns
            // as `skipped[]`. The codes and the sentences are unchanged; only `details`
            // grew, so no caller that read the code breaks.
            const unavailable = cart.items.filter((item) => {
              const variant = variantById.get(item.variantId);
              return !variant || !variant.productActive || !variant.variantActive;
            });
            if (unavailable.length) {
              throw new HttpError(
                422,
                "PRODUCT_UNAVAILABLE",
                "One or more cart products are unavailable.",
                {
                  lines: unavailable.map((item) =>
                    refusedLine(item, variantById.get(item.variantId), "unavailable", 0)
                  ),
                }
              );
            }
            const activeReservations = await tx.inventoryReservation.groupBy({
              by: ["variantId"],
              where: { storeId, variantId: { in: variantIds }, status: "active" },
              _sum: { quantity: true },
            });
            const reservedByVariant = new Map(
              activeReservations.map((reservation) => [
                reservation.variantId,
                reservation._sum.quantity ?? 0,
              ])
            );
            const short = cart.items.flatMap((item) => {
              const variant = variantById.get(item.variantId)!;
              // Marketplace M5: a pre-order is ordered BEFORE the stock arrives — that is
              // what it is. Its reservation is still written, so the units are spoken
              // for, and the order completes only once the merchant has the stock.
              if (variant.isPreorder) return [];
              const available = Math.max(
                0,
                variant.stockQuantity - (reservedByVariant.get(item.variantId) ?? 0)
              );
              return available < item.quantity
                ? [refusedLine(item, variant, "insufficient_stock", available)]
                : [];
            });
            if (short.length) {
              throw new HttpError(
                422,
                "INSUFFICIENT_AVAILABLE_STOCK",
                "One or more products do not have enough available stock.",
                { lines: short }
              );
            }
            // Marketplace M2: the merchant's per-order cap counts every variant of the
            // product together («حدّ أقصى ٢ لكل طلب» means two phones, whatever colour).
            // Read under the same lock as the stock, so a cap set mid-checkout applies.
            const unitsByProduct = new Map<string, number>();
            for (const item of cart.items) {
              const variant = variantById.get(item.variantId)!;
              unitsByProduct.set(
                variant.productId,
                (unitsByProduct.get(variant.productId) ?? 0) + item.quantity
              );
            }
            const overCap = cart.items.flatMap((item) => {
              const variant = variantById.get(item.variantId)!;
              return variant.maxPerOrder !== null &&
                (unitsByProduct.get(variant.productId) ?? 0) > variant.maxPerOrder
                ? [refusedLine(item, variant, "order_limit", variant.maxPerOrder)]
                : [];
            });
            if (overCap.length) {
              throw new HttpError(
                422,
                "ORDER_LIMIT_EXCEEDED",
                "One or more products exceed the quantity allowed per order.",
                { lines: overCap }
              );
            }
            /**
             * 19-د — THE SNAPSHOT IS RECONCILED WITH THE LOCKED PRICE BEFORE ANY MONEY
             * IS DECIDED.
             *
             * `priceSnapshotIqd` was captured when the line was created and NOTHING
             * revalidated it here: checkout summed the snapshot and stamped it as
             * `unitPriceIqd`, and the lock query above deliberately never selected
             * `v.price_iqd`. A customer cart has no expiry, so a line bought during a
             * promotion waited indefinitely for the merchant to restore his price —
             * and with the quantity raisable on that stale line, one order took
             * 450,000 IQD of goods for 50,000 and under-booked the platform's
             * commission on the same sale. The cart writers now re-price a line whose
             * quantity they raise, but a rule enforced only by three call sites is a
             * rule the fourth one breaks: this is the single place money is decided,
             * so this is where it is checked.
             *
             * IT REFUSES RATHER THAN RE-PRICING SILENTLY, in BOTH directions. Charging
             * the live price without asking would take more money than the shopper was
             * shown; honouring a snapshot below the live price takes it from the
             * merchant. Neither party may be moved without seeing the number, so the
             * order stops, the cart is corrected, and he confirms what he will pay.
             * That is not a failure and must not read like one: it is a named 422 with
             * a sentence naming the action, and `repriceStaleCartLines` has already
             * made the next tap succeed.
             */
            // Marketplace M5: paid add-ons, read inside the same transaction and held to
            // the same rule as the price — a removed add-on refuses the line by name, a
            // re-priced one is a moved price.
            const addonIds = Array.from(new Set(cart.items.flatMap((item) => item.addonIds)));
            const addonRows = addonIds.length
              ? await tx.productAddon.findMany({
                  where: { id: { in: addonIds }, storeId, isActive: true },
                  select: { id: true, productId: true, name: true, priceIqd: true },
                })
              : [];
            const addonById = new Map(addonRows.map((row) => [row.id, row]));
            const missingAddons = cart.items.filter((item) =>
              item.addonIds.some((id) => addonById.get(id)?.productId !== item.productId)
            );
            if (missingAddons.length) {
              throw new HttpError(
                422,
                "ADDON_UNAVAILABLE",
                "لم تعد بعض الإضافات المختارة متاحة. عدّل خياراتك ثم أكّد الطلب.",
                {
                  lines: missingAddons.map((item) =>
                    refusedLine(item, variantById.get(item.variantId), "unavailable", 0)
                  ),
                }
              );
            }
            const liveAddons = (item: { addonIds: string[] }) =>
              item.addonIds.reduce((sum, id) => sum + (addonById.get(id)?.priceIqd ?? 0), 0);
            const movedLines = cart.items
              .map((item) => ({
                id: item.id,
                snapshotIqd: item.priceSnapshotIqd,
                livePriceIqd: variantById.get(item.variantId)!.priceIqd,
                addonsSnapshotIqd: item.addonsSnapshotIqd,
                liveAddonsIqd: liveAddons(item),
              }))
              .filter(
                (line) =>
                  line.livePriceIqd !== line.snapshotIqd ||
                  line.liveAddonsIqd !== line.addonsSnapshotIqd
              );
            if (movedLines.length) throw new CartPriceMoved(cart.id, movedLines);
            // The add-ons are inside the line's unit price: one number the ledger, the
            // commission and every receipt already know how to read.
            const unitPrice = (item: { priceSnapshotIqd: number; addonsSnapshotIqd: number }) =>
              item.priceSnapshotIqd + item.addonsSnapshotIqd;
            const subtotalIqd = cart.items.reduce(
              (sum, item) => sum + item.quantity * unitPrice(item),
              0
            );
            // Phase 20B-1: discount = floor(subtotal*p/100) | min(amount, subtotal) | 0.
            // free_shipping zeroes the delivery fee ONLY (the waived amount is
            // snapshotted on the redemption) and never touches discount_iqd.
            const couponResult = coupon
              ? computeCouponDiscount(coupon, subtotalIqd)
              : { discountIqd: 0, freeShipping: false };
            const discountIqd = couponResult.discountIqd;
            const deliveryFeeIqd = couponResult.freeShipping ? 0 : deliveryRate.amountIqd;
            // CD-5: the redemption is priced and WRITTEN inside this transaction, after
            // the coupon, so points can never buy what the coupon already discounted.
            // The order id is not minted yet, so the spend row is written just below
            // with the order — see `redeemLoyaltyPoints`, which is called there.
            const loyaltyRequest =
              Number.isInteger(Number(input.loyaltyPoints)) && Number(input.loyaltyPoints) > 0
                ? Number(input.loyaltyPoints)
                : 0;
            const loyaltyPreview =
              loyaltyRequest > 0
                ? await previewLoyaltyRedemption(tx, {
                    storeId,
                    customerId,
                    requestedPoints: loyaltyRequest,
                    subtotalIqd,
                    couponDiscountIqd: discountIqd,
                  })
                : { points: 0, discountIqd: 0 };
            // One read of the customer: the boundary check, his name and email for the
            // order, and his market account for a platform coupon (review batch 2, ت-٢).
            const customer = await tx.customer.findFirst({
              where: { id: customerId, storeId },
              select: { fullName: true, email: true, shopperId: true },
            });
            if (!customer)
              throw new HttpError(
                403,
                "STORE_BOUNDARY_DENIED",
                "Customer does not belong to this store."
              );
            // Marketplace M8b: a PLATFORM coupon, on what is left after the store's own
            // coupon and points. The platform's cost — kept out of `discountIqd`, so it
            // lowers neither the commission base nor the store's payout. Its wallet row
            // is locked here, so two checkouts cannot both spend one coupon.
            const platformWalletId =
              typeof input.platformCouponWalletId === "string" && input.platformCouponWalletId
                ? input.platformCouponWalletId
                : null;
            const platformCoupon = platformWalletId
              ? await lockPlatformCouponForCheckout(tx, {
                  walletId: platformWalletId,
                  shopperId: customer.shopperId,
                  storeId,
                  baseIqd: subtotalIqd - discountIqd - loyaltyPreview.discountIqd,
                  now: new Date(),
                })
              : null;
            const platformDiscountIqd = platformCoupon?.discountIqd ?? 0;
            // The delivery fee is deliberately OUTSIDE what points may cover: a courier
            // is paid in money whatever the shopper redeems.
            const totalIqd =
              subtotalIqd -
              discountIqd -
              loyaltyPreview.discountIqd -
              platformDiscountIqd +
              deliveryFeeIqd;
            // ASVS 5.0 V1.4.2: 99 units of a very expensive item can exceed the 32-bit
            // order columns; refuse it plainly instead of failing inside the write.
            if (subtotalIqd > 2_147_483_647 || totalIqd > 2_147_483_647) {
              throw new HttpError(
                422,
                "ORDER_TOTAL_TOO_LARGE",
                "مبلغ الطلب أكبر من المسموح لطلبٍ واحد — قسّمه على أكثر من طلب."
              );
            }
            // Phase 20B-1: a product requiring a prescription stamps the order into the
            // pending_upload state at creation; the upload itself happens after checkout.
            const requiresPrescription = variants.some((variant) => variant.requiresPrescription);
            const order = await tx.storeOrder.create({
              data: {
                storeId,
                customerId,
                loyaltyPointsSpent: loyaltyPreview.points,
                loyaltyDiscountIqd: loyaltyPreview.discountIqd,
                orderNumber: orderNumber(),
                status: "new",
                fulfilment: pickup ? "pickup" : "delivery",
                customerName: address.recipientName || customer.fullName,
                customerEmail: customer.email,
                customerNote: normalizeCustomerNote(input.note),
                recipientPhone: address.phoneContactNormalized,
                shippingGovernorate: address.governorate,
                shippingAddressLine1: address.fullAddress,
                shippingAddressLine2: address.city,
                subtotalIqd,
                deliveryFeeIqd,
                discountIqd,
                platformDiscountIqd,
                platformCouponWalletId:
                  platformCoupon && platformDiscountIqd > 0 ? platformCoupon.walletId : null,
                couponId: coupon?.id ?? null,
                couponCode: coupon?.code ?? null,
                prescriptionStatus: requiresPrescription ? "pending_upload" : null,
                totalIqd,
                paymentStatus: initialPaymentStatus(paymentMethod),
                paymentMethodCode: paymentMethod.code,
                source: "storefront",
                updatedByKind: "customer",
                items: {
                  create: cart.items.map((item) => {
                    const variant = variantById.get(item.variantId)!;
                    return {
                      productId: item.productId,
                      variantId: item.variantId,
                      sku: variant.sku,
                      productName: variant.productName,
                      variantName: variant.name,
                      quantity: item.quantity,
                      unitPriceIqd: unitPrice(item),
                      lineTotalIqd: item.quantity * unitPrice(item),
                      addons: item.addonIds.map((id) => {
                        const addon = addonById.get(id)!;
                        return { id, name: addon.name, priceIqd: addon.priceIqd };
                      }),
                    };
                  }),
                },
                statusEvents: {
                  create: {
                    storeId,
                    fromStatus: null,
                    toStatus: "new",
                    actorKind: "customer",
                    actorId: customerId,
                    note: null,
                  },
                },
              },
              include: { items: true, statusEvents: true },
            });
            // CD-5: the spend row is written the moment the order it belongs to exists,
            // inside the same transaction that priced it — so a checkout that fails
            // later can never leave a shopper charged points for an order he has not got.
            await commitLoyaltyRedemption(tx, {
              storeId,
              customerId,
              orderId: order.id,
              redemption: loyaltyPreview,
            });
            // Marketplace M8b: the platform coupon is spent with the order or not at all.
            if (platformCoupon && platformDiscountIqd > 0)
              await markPlatformCouponUsed(tx, platformCoupon.walletId, order.id, new Date());
            // Phase 20B-1: the append-only redemption commits or rolls back with the
            // order; UNIQUE(order_id) makes "one coupon per order" structural.
            if (coupon)
              await tx.couponRedemption.create({
                data: {
                  storeId,
                  couponId: coupon.id,
                  orderId: order.id,
                  customerId,
                  discountIqd,
                  waivedDeliveryFeeIqd: couponResult.freeShipping ? deliveryRate.amountIqd : 0,
                },
              });
            await tx.inventoryReservation.createMany({
              data: cart.items.map((item) => ({
                storeId,
                orderId: order.id,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                status: "active",
              })),
            });
            const converted = await tx.shoppingCart.updateMany({
              where: {
                id: cart.id,
                storeId,
                customerId,
                status: CART_STATUS_ACTIVE,
                version: cartVersion,
              },
              data: { status: "converted", convertedOrderId: order.id, version: { increment: 1 } },
            });
            if (converted.count !== 1)
              throw new HttpError(
                409,
                "CART_VERSION_CONFLICT",
                "The cart was changed by another request."
              );
            await tx.checkoutRequest.update({
              where: { id: request.id },
              data: { status: "succeeded", orderId: order.id },
            });
            // Phase 15: the notification row commits or rolls back with the order itself.
            await enqueueOrderCreated(tx, {
              storeId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              totalIqd: order.totalIqd,
              customerName: order.customerName,
              customerEmail: order.customerEmail,
            });
            return { replayed: false, order };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        )
        .then((result) => {
          // After commit, and only for a NEW order — an idempotent replay announces nothing.
          if (!result.replayed)
            domainEvents.emit("order.created", {
              storeId,
              orderId: result.order.id,
              orderNumber: result.order.orderNumber,
              source: "storefront",
              totalIqd: result.order.totalIqd,
            });
          return result;
        });
    } catch (error) {
      lastError = error;
      // 19-د: a price that moved is not a busy server, so it never enters the
      // retry budget — retrying would only reach the same refusal three times.
      // The cart is corrected first so the refusal below is one tap from done.
      if (error instanceof CartPriceMoved) {
        await repriceStaleCartLines(storeId, error.cartId, error.lines);
        throw new HttpError(
          422,
          "CART_PRICE_CHANGED",
          "تغيّرت أسعار بعض منتجات سلتك قبل التأكيد. حدّثنا السلة بالأسعار الحالية — راجع الملخص ثم أكّد الطلب."
        );
      }
      // A shopper who taps «تأكيد الطلب» during a busy minute must not be told
      // the server failed. Same budget and jitter as the till (ق-132's
      // principle applies to the checkout button too).
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && isRetryableTransactionError(error)) {
        await sleepBeforeRetry(attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
