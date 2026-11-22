/**
 * Storefront — cart. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { LIVE } from "../soft-delete/constants.js";
import { HttpError } from "../../auth/auth.errors.js";
import { livePriceOf, livePrices } from "../live-price.js";
import {
  SERIALIZABLE_ATTEMPTS,
  isRetryableTransactionError,
  sleepBeforeRetry,
} from "../../db/serializable-retry.js";
import {
  CART_STATUS_ACTIVE,
  type CartContext,
  hash,
  randomGuestToken,
  nowPlusGuestLifetime,
  quantity,
  MAX_CART_QUANTITY,
} from "./shared.js";

/**
 * What every cart read returns its lines with: the product with its first image, the
 * variant, the lines in the order they were added. One definition, not ten copies
 * (review batch 2, ر-٥ — three copies had lost the ordering).
 */
const CART_WITH_ITEMS = {
  items: {
    include: {
      product: {
        include: { images: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 } },
      },
      variant: true,
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.ShoppingCartInclude;

function cartPayload(cart: Prisma.ShoppingCartGetPayload<{ include: typeof CART_WITH_ITEMS }>) {
  return {
    id: cart.id,
    status: cart.status,
    version: cart.version,
    expiresAt: cart.expiresAt,
    ownerKind: cart.ownerKind,
    items: cart.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      priceSnapshotIqd: item.priceSnapshotIqd,
      product: item.product
        ? {
            id: item.product.id,
            name: item.product.name,
            sku: item.product.sku,
            isActive: item.product.isActive,
            priceIqd: item.product.priceIqd,
            stockQuantity: item.product.stockQuantity,
            image: item.product.images?.[0] ?? null,
          }
        : null,
      variant: item.variant
        ? {
            id: item.variant.id,
            name: item.variant.name,
            sku: item.variant.sku,
            isActive: item.variant.isActive,
            priceIqd: item.variant.priceIqd,
            isDefault: item.variant.isDefault,
          }
        : null,
    })),
  };
}

async function expireGuestCartIfNeeded(cart: Parameters<typeof cartPayload>[0] | null) {
  if (
    cart?.ownerKind === "guest" &&
    cart.status === CART_STATUS_ACTIVE &&
    cart.expiresAt &&
    cart.expiresAt <= new Date()
  ) {
    await prisma.shoppingCart.updateMany({
      where: { id: cart.id, status: CART_STATUS_ACTIVE },
      data: { status: "expired", version: { increment: 1 } },
    });
    return null;
  }
  return cart;
}

async function activeCartForContext(
  storeId: string,
  context: CartContext,
  createIfMissing: boolean
) {
  if (context.customerId) {
    let cart = await prisma.shoppingCart.findFirst({
      where: {
        storeId,
        customerId: context.customerId,
        ownerKind: "customer",
        status: CART_STATUS_ACTIVE,
      },
      include: CART_WITH_ITEMS,
    });
    if (!cart && createIfMissing)
      cart = await prisma.shoppingCart.create({
        data: { storeId, ownerKind: "customer", customerId: context.customerId },
        include: CART_WITH_ITEMS,
      });
    return { cart, issuedGuestToken: undefined as string | undefined };
  }
  const tokenHash = context.guestToken ? hash(context.guestToken) : undefined;
  let cart = tokenHash
    ? await prisma.shoppingCart.findFirst({
        where: {
          storeId,
          ownerKind: "guest",
          sessionTokenHash: tokenHash,
          status: CART_STATUS_ACTIVE,
        },
        include: CART_WITH_ITEMS,
      })
    : null;
  cart = await expireGuestCartIfNeeded(cart);
  if (!cart && createIfMissing) {
    const issuedGuestToken = randomGuestToken();
    cart = await prisma.shoppingCart.create({
      data: {
        storeId,
        ownerKind: "guest",
        sessionTokenHash: hash(issuedGuestToken),
        expiresAt: nowPlusGuestLifetime(),
      },
      include: CART_WITH_ITEMS,
    });
    return { cart, issuedGuestToken };
  }
  return { cart, issuedGuestToken: undefined as string | undefined };
}

export async function currentCart(storeId: string, context: CartContext) {
  const { cart } = await activeCartForContext(storeId, context, false);
  return cart
    ? cartPayload(cart)
    : {
        id: null,
        status: "empty",
        version: 0,
        expiresAt: null,
        ownerKind: context.customerId ? "customer" : "guest",
        items: [],
      };
}

/**
 * Marketplace M2: the merchant's per-order cap, refused when the shopper adds
 * rather than only at checkout (which re-checks under its lock). Counts every
 * variant of the product already in this cart.
 */
async function assertWithinOrderLimit(
  tx: Prisma.TransactionClient,
  cartId: string,
  productId: string,
  adding: number
) {
  // LIVE: a trashed product has no limit to apply — checkout's lock refuses it anyway.
  const product = await tx.product.findFirst({
    where: { id: productId, ...LIVE },
    select: { maxPerOrder: true },
  });
  if (!product?.maxPerOrder) return;
  const inCart = await tx.cartItem.aggregate({
    where: { cartId, productId },
    _sum: { quantity: true },
  });
  if ((inCart._sum.quantity ?? 0) + adding > product.maxPerOrder) {
    throw new HttpError(
      422,
      "ORDER_LIMIT_EXCEEDED",
      `الحدّ الأقصى لهذا المنتج ${product.maxPerOrder} لكل طلب.`,
      { maxPerOrder: product.maxPerOrder }
    );
  }
}

/**
 * The store's per-order cap, as a yes/no for a best-effort writer (review batch 2, ت-٦):
 * «أعد الطلب» skips a line over the cap instead of adding what checkout would refuse.
 */
async function withinOrderLimit(
  tx: Prisma.TransactionClient,
  cartId: string,
  line: { productId: string; quantity: number }
) {
  try {
    await assertWithinOrderLimit(tx, cartId, line.productId, line.quantity);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.code === "ORDER_LIMIT_EXCEEDED") return false;
    throw error;
  }
}

export async function addCartItem(
  storeId: string,
  context: CartContext,
  input: { productId?: unknown; variantId?: unknown; quantity?: unknown }
) {
  // Phase 20A: the cart line targets a variant. `variantId` is the primary input;
  // a bare `productId` (legacy storefront clients and pre-20A tests) resolves the
  // product's implicit default variant so single-variant products keep working
  // without any client change.
  const requestedVariantId = typeof input.variantId === "string" ? input.variantId : undefined;
  const requestedProductId = typeof input.productId === "string" ? input.productId : undefined;
  if (!requestedVariantId && !requestedProductId)
    throw new HttpError(400, "INVALID_PRODUCT", "productId or variantId is required.");
  const requestedQuantity = quantity(input.quantity);
  const variant = await prisma.productVariant.findFirst({
    where: requestedVariantId
      ? {
          id: requestedVariantId,
          storeId,
          isActive: true,
          ...(requestedProductId ? { productId: requestedProductId } : {}),
          product: { isActive: true },
        }
      : {
          productId: requestedProductId,
          storeId,
          isDefault: true,
          isActive: true,
          product: { isActive: true },
        },
  });
  if (!variant)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested product was not found in this store."
    );
  const { cart, issuedGuestToken } = await activeCartForContext(storeId, context, true);
  if (!cart) throw new HttpError(500, "CART_CREATION_FAILED", "Cart could not be created.");
  const updated = await prisma.$transaction(async (tx) => {
    await assertWithinOrderLimit(tx, cart.id, variant.productId, requestedQuantity);
    // 19-د: adding to an existing line ALWAYS raises its quantity, so the line
    // is re-priced from the variant that was just read. See `updateCartItem`
    // for the rule and why it is bounded to increases.
    // Marketplace M8a: the snapshot is the LIVE price — an hourly deal's price while it runs.
    const livePrice = await livePriceOf(tx, variant.id, variant.priceIqd);
    // Review batch 2, م-٣: ONE statement adds the units — insert the line, or raise it by
    // `increment` under the row's lock. Reading the quantity and writing back the sum lost
    // additions: ten simultaneous «add one» became two or three units.
    const line = await tx.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
      create: {
        cartId: cart.id,
        storeId,
        productId: variant.productId,
        variantId: variant.id,
        quantity: requestedQuantity,
        priceSnapshotIqd: livePrice,
      },
      update: { quantity: { increment: requestedQuantity }, priceSnapshotIqd: livePrice },
      select: { quantity: true },
    });
    // Over the ceiling: refused, and the transaction takes the units back with it.
    if (line.quantity > MAX_CART_QUANTITY)
      throw new HttpError(
        422,
        "INVALID_CART_QUANTITY",
        `quantity cannot exceed ${MAX_CART_QUANTITY}.`
      );
    return tx.shoppingCart.update({
      where: { id: cart.id },
      data: {
        version: { increment: 1 },
        lastActivityAt: new Date(),
        ...(cart.ownerKind === "guest" ? { expiresAt: nowPlusGuestLifetime() } : {}),
      },
      include: CART_WITH_ITEMS,
    });
  });
  return { cart: cartPayload(updated), issuedGuestToken, guestExpiresAt: updated.expiresAt };
}

export async function updateCartItem(
  storeId: string,
  context: CartContext,
  itemId: string,
  rawQuantity: unknown
) {
  const requestedQuantity = quantity(rawQuantity);
  const { cart } = await activeCartForContext(storeId, context, false);
  if (!cart)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id, storeId } });
  if (!item)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  /**
   * 19-د — THE SNAPSHOT COVERS THE UNITS IT WAS TAKEN FOR.
   *
   * Freezing the price a shopper saw is a documented decision (PHASE9, CART-03:
   * checkout recomputes from `price_snapshot_iqd`, not from the current price),
   * and it stays. What was never decided is what happens when he then RAISES the
   * quantity on that frozen line: the snapshot silently extended a promotional
   * unit price to up to 98 further units he never added at that price, with no
   * cap and no revalidation — and a customer cart has no expiry, so the stale
   * line waits indefinitely for the next price rise. Reproduced at 450,000 IQD
   * taken from the merchant in a single order, under-booking the platform's
   * commission on the same sale.
   *
   * So: raising a line's quantity re-prices it from the live variant; lowering
   * or leaving it does not. Bounded to increases on purpose — a shopper
   * trimming his basket has not asked for anything new, and re-pricing him then
   * would take away the price he was promised for units he already had.
   *
   * A missing variant row leaves the snapshot alone; checkout's FOR UPDATE lock
   * refuses that line anyway (PRODUCT_UNAVAILABLE), which is the honest answer.
   */
  // ...LIVE is not decoration here: a TRASHED variant has no live price to
  // quote. Without it a soft-deleted line would be re-priced from a row the
  // shopper can no longer buy — and checkout's FOR UPDATE lock would then
  // refuse it anyway, after we had already rewritten his snapshot.
  const listed =
    requestedQuantity > item.quantity
      ? await prisma.productVariant.findFirst({
          where: { id: item.variantId, storeId, ...LIVE },
          select: { id: true, priceIqd: true },
        })
      : null;
  const livePriceIqd = listed ? await livePriceOf(prisma, listed.id, listed.priceIqd) : undefined;
  const updated = await prisma.$transaction(async (tx) => {
    if (requestedQuantity > item.quantity)
      await assertWithinOrderLimit(tx, cart.id, item.productId, requestedQuantity - item.quantity);
    await tx.cartItem.update({
      where: { id: item.id },
      data: {
        quantity: requestedQuantity,
        ...(livePriceIqd === undefined ? {} : { priceSnapshotIqd: livePriceIqd }),
      },
    });
    return tx.shoppingCart.update({
      where: { id: cart.id },
      data: {
        version: { increment: 1 },
        lastActivityAt: new Date(),
        ...(cart.ownerKind === "guest" ? { expiresAt: nowPlusGuestLifetime() } : {}),
      },
      include: CART_WITH_ITEMS,
    });
  });
  return cartPayload(updated);
}

export async function removeCartItem(storeId: string, context: CartContext, itemId: string) {
  const { cart } = await activeCartForContext(storeId, context, false);
  if (!cart)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id, storeId } });
  if (!item)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  await prisma.$transaction(async (tx) => {
    await tx.cartItem.delete({ where: { id: item.id } });
    await tx.shoppingCart.update({
      where: { id: cart.id },
      data: {
        version: { increment: 1 },
        lastActivityAt: new Date(),
        ...(cart.ownerKind === "guest" ? { expiresAt: nowPlusGuestLifetime() } : {}),
      },
    });
  });
}

export async function mergeGuestCartIntoCustomer(
  storeId: string,
  customerId: string,
  guestToken?: string
) {
  if (!guestToken) return currentCart(storeId, { customerId });
  const guestHash = hash(guestToken);
  let lastError: unknown;
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const guest = await tx.shoppingCart.findFirst({
            where: { storeId, ownerKind: "guest", sessionTokenHash: guestHash },
            include: { items: true },
          });
          if (
            !guest ||
            guest.status !== CART_STATUS_ACTIVE ||
            (guest.expiresAt && guest.expiresAt <= new Date())
          ) {
            if (guest?.status === CART_STATUS_ACTIVE)
              await tx.shoppingCart.update({
                where: { id: guest.id },
                data: { status: "expired", version: { increment: 1 } },
              });
            const customerCart = await tx.shoppingCart.findFirst({
              where: { storeId, customerId, ownerKind: "customer", status: CART_STATUS_ACTIVE },
              include: CART_WITH_ITEMS,
            });
            return customerCart
              ? cartPayload(customerCart)
              : {
                  id: null,
                  status: "empty",
                  version: 0,
                  expiresAt: null,
                  ownerKind: "customer",
                  items: [],
                };
          }
          let customerCart = await tx.shoppingCart.findFirst({
            where: { storeId, customerId, ownerKind: "customer", status: CART_STATUS_ACTIVE },
            include: { items: true },
          });
          if (!customerCart)
            customerCart = await tx.shoppingCart.create({
              data: { storeId, customerId, ownerKind: "customer" },
              include: { items: true },
            });
          for (const guestItem of guest.items) {
            const variant = await tx.productVariant.findFirst({
              where: { id: guestItem.variantId, storeId },
              select: {
                id: true,
                isActive: true,
                priceIqd: true,
                product: { select: { isActive: true } },
              },
            });
            const existing = await tx.cartItem.findUnique({
              where: {
                cartId_variantId: { cartId: customerCart.id, variantId: guestItem.variantId },
              },
            });
            const mergedQuantity = (existing?.quantity ?? 0) + guestItem.quantity;
            if (mergedQuantity > MAX_CART_QUANTITY)
              throw new HttpError(
                422,
                "INVALID_CART_QUANTITY",
                `Merged quantity cannot exceed ${MAX_CART_QUANTITY}.`
              );
            const snapshot =
              variant?.isActive && variant.product.isActive
                ? await livePriceOf(tx, variant.id, variant.priceIqd)
                : guestItem.priceSnapshotIqd;
            if (existing)
              await tx.cartItem.update({
                where: { id: existing.id },
                data: { quantity: mergedQuantity, priceSnapshotIqd: snapshot },
              });
            else
              await tx.cartItem.create({
                data: {
                  cartId: customerCart.id,
                  storeId,
                  productId: guestItem.productId,
                  variantId: guestItem.variantId,
                  quantity: guestItem.quantity,
                  priceSnapshotIqd: snapshot,
                },
              });
          }
          await tx.shoppingCart.update({
            where: { id: guest.id },
            data: {
              status: "merged",
              mergedIntoCartId: customerCart.id,
              version: { increment: 1 },
            },
          });
          const refreshed = await tx.shoppingCart.update({
            where: { id: customerCart.id },
            data: { version: { increment: 1 }, lastActivityAt: new Date() },
            include: CART_WITH_ITEMS,
          });
          return cartPayload(refreshed);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      lastError = error;
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && isRetryableTransactionError(error)) {
        await sleepBeforeRetry(attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * CD-1c — «اطلبه مجدداً»: one-click reorder from the customer's own history.
 *
 * BEST-EFFORT BY CONTRACT. A reorder never fails as a whole because one line
 * went stale; every line that cannot be added is reported honestly in `skipped`
 * with the reason, and everything else lands in the cart. The three reasons are:
 *
 *   product_unavailable — the variant (or its parent product) was deleted or
 *                         deactivated since the order, or the historical line
 *                         carries no variant at all (legacy/manual orders);
 *   insufficient_stock  — available stock (stock minus active reservations) is
 *                         below the line quantity;
 *   quantity_limit      — the cart already holds this variant and the combined
 *                         quantity would exceed MAX_CART_QUANTITY.
 *
 * The names in `skipped` come from the LIVE variant when it still exists and
 * from the order-line snapshot when it does not, so a deleted product is still
 * nameable to the customer.
 *
 * Checkout is untouched and remains the sole authority on availability: this is
 * a cart convenience, and its stock read is advisory exactly like the catalog's.
 * Prices use the CURRENT variant price, matching addCartItem.
 */
export type ReorderSkipReason = "product_unavailable" | "insufficient_stock" | "quantity_limit";

export type ReorderSkip = {
  productName: string;
  variantName: string | null;
  reason: ReorderSkipReason;
};

export async function reorderIntoCart(storeId: string, customerId: string, orderId: string) {
  // Ownership AND store scope are part of the same equality match, so another
  // customer's order and another store's order are both a plain 404.
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    select: {
      id: true,
      items: {
        select: { variantId: true, quantity: true, productName: true, variantName: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");

  const skipped: ReorderSkip[] = [];
  // Historical orders can, in principle, carry the same variant twice; merge
  // them so the cart line is computed once against stock.
  const requested = new Map<
    string,
    { variantId: string; quantity: number; productName: string; variantName: string | null }
  >();
  for (const item of order.items) {
    if (!item.variantId) {
      skipped.push({
        productName: item.productName,
        variantName: item.variantName,
        reason: "product_unavailable",
      });
      continue;
    }
    const merged = requested.get(item.variantId);
    if (merged) merged.quantity += item.quantity;
    else
      requested.set(item.variantId, {
        variantId: item.variantId,
        quantity: item.quantity,
        productName: item.productName,
        variantName: item.variantName,
      });
  }

  const variantIds = Array.from(requested.keys());
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: variantIds }, storeId },
        select: {
          id: true,
          productId: true,
          name: true,
          isActive: true,
          priceIqd: true,
          stockQuantity: true,
          product: { select: { name: true, isActive: true } },
        },
      })
    : [];
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const reservations = variantIds.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: { storeId, variantId: { in: variantIds }, status: "active" },
        _sum: { quantity: true },
      })
    : [];
  const reservedByVariant = new Map(
    reservations.map((reservation) => [reservation.variantId, reservation._sum.quantity ?? 0])
  );

  const additions: Array<{
    variantId: string;
    productId: string;
    priceIqd: number;
    quantity: number;
    productName: string;
    variantName: string | null;
  }> = [];
  const livePriceByVariant = await livePrices(prisma, Array.from(variantById.keys()));
  for (const line of Array.from(requested.values())) {
    const variant = variantById.get(line.variantId);
    if (!variant || !variant.isActive || !variant.product.isActive) {
      skipped.push({
        productName: variant?.product.name ?? line.productName,
        variantName: variant?.name ?? line.variantName,
        reason: "product_unavailable",
      });
      continue;
    }
    if (variant.stockQuantity - (reservedByVariant.get(variant.id) ?? 0) < line.quantity) {
      skipped.push({
        productName: variant.product.name,
        variantName: variant.name,
        reason: "insufficient_stock",
      });
      continue;
    }
    additions.push({
      variantId: variant.id,
      productId: variant.productId,
      priceIqd: livePriceByVariant.get(variant.id) ?? variant.priceIqd,
      quantity: line.quantity,
      productName: variant.product.name,
      variantName: variant.name,
    });
  }

  // Everything went stale: report honestly against the cart the customer already
  // has, without creating an empty one.
  if (!additions.length)
    return { cart: await currentCart(storeId, { customerId }), skipped, addedCount: 0 };

  const { cart } = await activeCartForContext(storeId, { customerId }, true);
  if (!cart) throw new HttpError(500, "CART_CREATION_FAILED", "Cart could not be created.");
  const result = await prisma.$transaction(async (tx) => {
    const limitSkips: ReorderSkip[] = [];
    let addedCount = 0;
    for (const addition of additions) {
      const existing = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId: addition.variantId } },
      });
      const nextQuantity = (existing?.quantity ?? 0) + addition.quantity;
      if (nextQuantity > MAX_CART_QUANTITY || !(await withinOrderLimit(tx, cart.id, addition))) {
        limitSkips.push({
          productName: addition.productName,
          variantName: addition.variantName,
          reason: "quantity_limit",
        });
        continue;
      }
      // LOY-1: a reorder onto an EXISTING line re-prices it, exactly as
      // `addCartItem` does. The product call 19-د deferred is made: reorder was
      // the last route by which a stale snapshot could be stretched over more
      // units, and it is closed.
      //
      // The money argument was already settled by 19-د — checkout refuses any
      // line whose snapshot no longer matches the live price (CART_PRICE_CHANGED)
      // — so what is left is the shopper's experience, and it is the whole
      // reason to change this. He taps «أعد الطلب», is handed a cart built on a
      // price that no longer exists, and is refused at the till with no way to
      // see what went wrong. Re-pricing here gives him a cart that is simply
      // correct, priced from the same read that decided the line was available.
      if (existing)
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity: nextQuantity, priceSnapshotIqd: addition.priceIqd },
        });
      else
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            storeId,
            productId: addition.productId,
            variantId: addition.variantId,
            quantity: addition.quantity,
            priceSnapshotIqd: addition.priceIqd,
          },
        });
      addedCount += 1;
    }
    // Nothing was actually added (every addition hit the quantity cap): read the
    // cart back untouched instead of bumping its version, which would look like
    // success to the client and could break a concurrent checkout's cartVersion.
    if (!addedCount) {
      const unchanged = await tx.shoppingCart.findUniqueOrThrow({
        where: { id: cart.id },
        include: CART_WITH_ITEMS,
      });
      return { updated: unchanged, limitSkips, addedCount };
    }
    const updated = await tx.shoppingCart.update({
      where: { id: cart.id },
      data: { version: { increment: 1 }, lastActivityAt: new Date() },
      include: CART_WITH_ITEMS,
    });
    return { updated, limitSkips, addedCount };
  });
  return {
    cart: cartPayload(result.updated),
    skipped: [...skipped, ...result.limitSkips],
    addedCount: result.addedCount,
  };
}
