/**
 * CD-2 «نبّهني عند التوفر» — the back-in-stock scanner.
 *
 * A FIFTH overlap-guarded interval in the standalone worker (ADR-004). It only
 * enqueues; delivery stays with the outbox worker, which applies the marketing
 * gate — unsubscribe, daily cap — because this message is classified marketing
 * (see the CD-2 migration for why a message the shopper asked for is still
 * marketing).
 *
 * WHY A SCANNER RATHER THAN A HOOK ON THE STOCK WRITE. The obvious design is to
 * enqueue inside the transaction that raises stock. That transaction is on the
 * checkout and inventory paths, and it would then carry a "who is waiting for
 * this?" query plus N inserts — turning a restock of fifty variants into fifty
 * fan-outs inside one lock. Here the work is outside every request path, and a
 * missed pass costs a few minutes, not a message.
 *
 * ONCE PER ASK. The dedupe key is the WISHLIST ROW id —
 * `back_in_stock:{wishlistItemId}` — and the flag that asked for it is cleared
 * in the same transaction as the enqueue.
 *
 * Both halves matter. Clearing the flag is what makes this candidate set DRAIN,
 * so the scanner stops reconsidering a shopper it has already paged. And keying
 * on the row rather than on `{variantId}:{customerId}` is what lets him ask
 * AGAIN: a new row has a new id, so removing the item and re-adding it works,
 * where a variant+customer key would have silenced him permanently on his first
 * alert. Keying by day would page him every morning the shirt stayed in stock.
 *
 * The two together mean: one message per request, and a request can be made
 * again. Neither a shopper mailed weekly about a shirt he forgot, nor one who
 * can never be told twice.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export const RESTOCK_SCAN_INTERVAL_MS = 10 * 60 * 1000;
/** Waiting shoppers read per round trip; the pass pages until exhausted. */
const SCAN_PAGE_SIZE = 200;

export interface RestockScanResult {
  candidates: number;
  enqueued: number;
  duplicates: number;
}

/**
 * Review batch 5, ت-٣ — one key per ASK, not per wishlist row. «نبّهني» pressed again on an item
 * already in the list updates the same row; a key of the row's id alone collided with the first
 * alert, rolled the transaction back, left the request standing and retried it every pass for
 * ever. The n-th alert for a row is `back_in_stock:{row}:{n}` — after the largest key that still
 * exists (the first alert's legacy key has no suffix and counts as 0). Two scanners racing on the
 * same ask compute the same key, so the unique index still makes it one message.
 */
async function nextRestockKey(
  tx: Prisma.TransactionClient,
  storeId: string,
  itemId: string
): Promise<string> {
  const base = `back_in_stock:${itemId}`;
  const earlier = await tx.notificationOutbox.findMany({
    where: { storeId, dedupeKey: { startsWith: base } },
    select: { dedupeKey: true },
  });
  if (!earlier.length) return base;
  const last = Math.max(
    ...earlier.map((row) =>
      row.dedupeKey === base ? 0 : Number(row.dedupeKey!.slice(base.length + 1)) || 0
    )
  );
  return `${base}:${last + 1}`;
}

export async function scanRestocks(): Promise<RestockScanResult> {
  const result: RestockScanResult = { candidates: 0, enqueued: 0, duplicates: 0 };
  let cursor: string | undefined;

  for (;;) {
    const waiting = await prisma.wishlistItem.findMany({
      where: {
        notifyOnRestock: true,
        // Back in stock, and actually buyable: an active variant of an active,
        // untrashed product in a store that is open.
        variant: { stockQuantity: { gt: 0 }, isActive: true, deletedAt: null },
        product: { isActive: true, deletedAt: null },
        // ق-208: the store's master messaging switch and its marketing cap gate
        // THIS scanner exactly as they gate the abandoned-cart scanner. Before,
        // a store that had never switched messaging on — the default for every
        // store — had marketing mail sent in its name; and because the request
        // flag is cleared in the same transaction as the enqueue, a row the
        // worker then refused (cap 0 / disabled) burned the shopper's «نبّهني»
        // with no message ever arriving. Refusing here leaves his request
        // standing until the store can actually honour it.
        store: {
          isActive: true,
          notificationSettings: { isEnabled: true, marketingDailyCap: { gt: 0 } },
        },
        // A customer registered by phone alone has nowhere to be written to
        // until the WhatsApp channel arrives in 25ب. Excluded HERE rather than
        // fetched and discarded: this candidate set only drains when a message
        // is sent, so a row that can never be sent would otherwise be re-read on
        // every pass, for ever, growing with every such shopper. His request is
        // left standing — add an email and the next restock reaches him.
        customer: { email: { not: null } },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: SCAN_PAGE_SIZE,
      select: {
        id: true,
        storeId: true,
        variantId: true,
        customerId: true,
        productId: true,
        customer: { select: { email: true, fullName: true } },
        product: { select: { name: true } },
        variant: { select: { name: true, isDefault: true, priceIqd: true } },
        store: { select: { slug: true, name: true } },
      },
    });
    if (waiting.length === 0) break;
    cursor = waiting[waiting.length - 1]!.id;
    result.candidates += waiting.length;

    for (const item of waiting) {
      try {
        // One transaction: the message is queued and the request that asked for
        // it is retired together. Split apart, a crash between them either pages
        // him twice or drops the alert he asked for.
        await prisma.$transaction(async (tx) => {
          const dedupeKey = await nextRestockKey(tx, item.storeId, item.id);
          await tx.notificationOutbox.create({
            data: {
              storeId: item.storeId,
              eventType: "stock.back_in_stock",
              recipientKind: "customer",
              channel: "email",
              recipient: item.customer.email!,
              dedupeKey,
              payload: {
                storeName: item.store.name,
                storeSlug: item.store.slug,
                productName: item.variant.isDefault
                  ? item.product.name
                  : `${item.product.name} — ${item.variant.name}`,
                priceIqd: item.variant.priceIqd,
                productUrl: `/store/${item.store.slug}/products/${item.productId}`,
              },
            },
          });
          await tx.wishlistItem.update({
            where: { id: item.id },
            data: { notifyOnRestock: false },
          });
        });
        result.enqueued += 1;
      } catch (error) {
        // The unique key catches a concurrent pass that got here first.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          result.duplicates += 1;
        else throw error;
      }
    }
  }

  return result;
}
