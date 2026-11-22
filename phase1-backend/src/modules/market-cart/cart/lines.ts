/**
 * The market cart — lines. Split verbatim from cart.service.ts (review batch 2, ت-١٥);
 * cart.service.ts re-exports what it always exported.
 */
import { withSerializableRetry } from "../../../db/serializable-retry.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { livePriceOf } from "../../../services/live-price.js";
import {
  cartFor,
  VARIANT_FACTS,
  assertSellable,
  addonsTotal,
  MAX_LINES,
  assertQuantity,
} from "./rules.js";
import { marketCartView } from "./view.js";

/**
 * Every change to one shopper's cart waits for the one before it (review batch 2, ت-١٤). Its
 * checks are advisory — checkout decides under its own locks — so this is a row lock at
 * READ COMMITTED, not a serializable transaction: eight taps at once used to lose to each other
 * and answer «busy»; now they queue. The retry still covers the first-ever cart's creation race.
 */
async function lockCart(tx: Prisma.TransactionClient, cartId: string) {
  await tx.$queryRaw`SELECT id FROM market_carts WHERE id = ${cartId}::uuid FOR UPDATE`;
}

export async function addCartLine(
  shopperId: string,
  input: { productId?: string; variantId?: string; quantity: number; addonIds: string[] }
) {
  return withSerializableRetry(() =>
    prisma.$transaction(async (tx) => {
      const cart = await cartFor(shopperId, tx);
      await lockCart(tx, cart.id);
      const variant = input.variantId
        ? await tx.productVariant.findFirst({
            where: {
              id: input.variantId,
              deletedAt: null,
              ...(input.productId ? { productId: input.productId } : {}),
            },
            select: VARIANT_FACTS,
          })
        : await tx.productVariant.findFirst({
            where: { productId: input.productId, isDefault: true, deletedAt: null },
            select: VARIANT_FACTS,
          });
      assertSellable(variant);
      const addons = await addonsTotal(tx, variant.productId, input.addonIds);
      const existing = await tx.marketCartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
      });
      if (!existing && (await tx.marketCartItem.count({ where: { cartId: cart.id } })) >= MAX_LINES)
        throw new HttpError(422, "CART_FULL", "السلة ممتلئة.");
      const quantity = (existing?.quantity ?? 0) + input.quantity;
      await assertQuantity(tx, cart.id, variant, quantity, existing?.id ?? null);
      // Adding again re-prices the line at what the shopper sees right now (the store cart's rule, 19-د).
      // Marketplace M8a: the LIVE price — an hourly deal's while it runs.
      const data = {
        quantity,
        addonIds: input.addonIds,
        priceSnapshotIqd: await livePriceOf(tx, variant.id, variant.priceIqd),
        addonsSnapshotIqd: addons,
      };
      if (existing) await tx.marketCartItem.update({ where: { id: existing.id }, data });
      else
        await tx.marketCartItem.create({
          data: {
            ...data,
            cartId: cart.id,
            storeId: variant.storeId,
            productId: variant.productId,
            variantId: variant.id,
          },
        });
      await tx.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
    })
  ).then(() => marketCartView(shopperId));
}

export async function updateCartLine(
  shopperId: string,
  lineId: string,
  input: { quantity?: number; variantId?: string; addonIds?: string[] }
) {
  return withSerializableRetry(() =>
    prisma.$transaction(async (tx) => {
      const cart = await cartFor(shopperId, tx);
      await lockCart(tx, cart.id);
      const line = await tx.marketCartItem.findFirst({ where: { id: lineId, cartId: cart.id } });
      if (!line) throw new HttpError(404, "CART_LINE_NOT_FOUND", "هذا المنتج لم يعد في سلتك.");
      const variantId = input.variantId ?? line.variantId;
      if (
        variantId !== line.variantId &&
        (await tx.marketCartItem.findUnique({
          where: { cartId_variantId: { cartId: cart.id, variantId } },
        }))
      ) {
        throw new HttpError(409, "CART_LINE_EXISTS", "هذا الاختيار موجود في سلتك بالفعل.");
      }
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId: line.productId, deletedAt: null },
        select: VARIANT_FACTS,
      });
      assertSellable(variant);
      const addonIds = input.addonIds ?? line.addonIds;
      const quantity = input.quantity ?? line.quantity;
      await assertQuantity(tx, cart.id, variant, quantity, line.id);
      const changedChoice = variantId !== line.variantId || input.addonIds !== undefined;
      // Re-price when the shopper raises the quantity or changes what he is buying; a decrease keeps his price.
      const reprice = changedChoice || quantity > line.quantity;
      await tx.marketCartItem.update({
        where: { id: line.id },
        data: {
          quantity,
          variantId,
          addonIds,
          ...(reprice
            ? {
                priceSnapshotIqd: await livePriceOf(tx, variant.id, variant.priceIqd),
                addonsSnapshotIqd: await addonsTotal(tx, line.productId, addonIds),
              }
            : {}),
        },
      });
      await tx.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
    })
  ).then(() => marketCartView(shopperId));
}

export async function removeCartLine(shopperId: string, lineId: string) {
  const cart = await cartFor(shopperId);
  const removed = await prisma.marketCartItem.deleteMany({
    where: { id: lineId, cartId: cart.id },
  });
  if (removed.count === 0)
    throw new HttpError(404, "CART_LINE_NOT_FOUND", "هذا المنتج لم يعد في سلتك.");
  await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
  return marketCartView(shopperId);
}

export async function clearCart(shopperId: string) {
  const cart = await cartFor(shopperId);
  await prisma.marketCartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
  return marketCartView(shopperId);
}
