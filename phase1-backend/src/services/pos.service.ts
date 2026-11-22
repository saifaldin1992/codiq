/**
 * الكاشير (ق-132, ق-135) — the counter sale, on the same order book.
 *
 * ============================================================================
 * WHAT A POS SALE IS
 * ============================================================================
 *
 * A StoreOrder with `source: "pos"`, BORN COMPLETED and BORN PAID. The customer
 * is standing at the counter holding the goods and the merchant is holding the
 * cash — there is no "processing", no courier, nothing to wait for. اكد's own
 * public documentation lands on the identical rule («بيعة الكاشير تبدأ عند تم
 * التوصيل، لأن الزبون خرج بالبضاعة أصلًا»), which is worth noting precisely
 * because we arrived at it independently: it is what the physics of a counter
 * sale forces. Writing it as a StoreOrder — not a parallel table — is what
 * buys ONE stock balance and one order book across both channels, the gap
 * none of اكد, IQ Soft or ويل fill together.
 *
 * The order lifecycle table is UNTOUCHED. `completed` is already a real state
 * with its real outgoing edge (`returned`), so a POS sale can be returned
 * through the existing returns machinery with zero new code. What we skip is
 * only the journey, and we skip it by creating the order already arrived.
 *
 * ============================================================================
 * NO LEDGER ENTRY. NO COMMISSION. (ق-135)
 * ============================================================================
 *
 * The finance ledger records money the PLATFORM handles — collected from a
 * courier, owed to the merchant. Counter cash never passes through the
 * platform; the merchant is already holding it. An entry here, even at zero
 * commission, would make his wallet claim the platform owes him money it
 * never took. Worse: both ledger readers treat every type that is not
 * `order_completed` as a SUBTRACTION (see ledger-sign.guard.mjs), so the
 * "obvious" pos_sale entry type would silently subtract every counter sale
 * from his revenue. The reports surface POS takings from ORDERS instead,
 * as their own line: money in the till is not money awaited from the platform.
 *
 * ============================================================================
 * IDEMPOTENCY — the till names the sale, the database enforces it
 * ============================================================================
 *
 * The cashier presses «حصّل», the screen hangs, he presses again. That is ONE
 * sale, and a naive server records two. The till mints `ticketId` at ring-up;
 * UNIQUE (store_id, device_id, ticket_id) makes the replay collide; the
 * friendly half returns the original order with `replayed: true`. A direct
 * transliteration of the checkout path (`storefront.service.ts`), which has
 * carried these semantics since 9A — customer swapped for device.
 *
 * ============================================================================
 * STOCK — clamp, never refuse, never lie silently
 * ============================================================================
 *
 * The storefront may refuse a checkout: the shopper is remote and nothing has
 * happened yet. The till may NOT refuse a sync: the unit already left the shop
 * and the money is already in the drawer. Refusing deletes the record of a
 * real sale — the exact failure that sends a merchant back to a paper
 * notebook. So the decrement clamps at zero (the CHECK constraint forbids
 * negatives) and the gap is recorded as a shortfall, loudly, for the merchant
 * to reconcile. An accepted discrepancy beats a rejected truth.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { SERIALIZABLE_ATTEMPTS, isRetryableTransactionError, sleepBeforeRetry } from "../db/serializable-retry.js";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { enqueueLowStockIfCrossed } from "../notifications/notification-outbox.service.js";
import { LIVE } from "./soft-delete/constants.js";
import { domainEvents } from "../events/domain-events.js";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * Four characters that survive being read aloud over a shop's noise and typed
 * from a printed receipt. Same alphabet discipline as the recovery codes:
 * no I, L, O, U, 0, 1 — the ones people misread.
 */
const DEVICE_SHORT_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
function newDeviceShort(): string {
  return Array.from({ length: 4 }, () => DEVICE_SHORT_ALPHABET[crypto.randomInt(DEVICE_SHORT_ALPHABET.length)]).join("");
}

// ---------------------------------------------------------------- devices

export async function createPosDevice(storeId: string, input: { label: unknown }) {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length < 2 || label.length > 60) {
    throw new HttpError(422, "INVALID_DEVICE_LABEL", "اسم الجهاز يجب أن يتكون من حرفين إلى ستين حرفاً — مثل «كاشير ١».");
  }
  // deviceShort is unique per store; on the astronomically rare collision the
  // constraint fires and one retry resolves it.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const device = await prisma.posDevice.create({
        data: { storeId, label, deviceShort: newDeviceShort() },
        select: { id: true, label: true, deviceShort: true, createdAt: true },
      });
      return { device };
    } catch (error) {
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && isRetryableTransactionError(error)) {
        await sleepBeforeRetry(attempt);
        continue;
      }
      throw error;
    }
  }
}

export async function listPosDevices(storeId: string) {
  const devices = await prisma.posDevice.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    // Bounded: a store has a handful of tills; 200 is far past any real one,
    // and keeps the screen from loading an unbounded history of revoked ones.
    take: 200,
    select: { id: true, label: true, deviceShort: true, revokedAt: true, lastSeenAt: true, createdAt: true },
  });
  return { devices };
}

/**
 * Revoked, never deleted. The till's past sales keep naming it, and «هذا
 * الجهاز أُلغي يوم كذا» stays a checkable fact. Idempotent: revoking twice
 * keeps the FIRST timestamp, because "when did this stop being trusted" is an
 * audit answer that must not move on a double-click.
 */
export async function revokePosDevice(storeId: string, deviceId: string) {
  const result = await prisma.posDevice.updateMany({
    where: { id: deviceId, storeId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    const exists = await prisma.posDevice.findFirst({ where: { id: deviceId, storeId }, select: { id: true } });
    if (!exists) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الجهاز غير موجود.");
  }
}

// ---------------------------------------------------------------- the sale

interface TicketLineInput {
  variantId: string;
  quantity: number;
  unitPriceIqd: number;
}

export interface PosTicketInput {
  deviceId: unknown;
  ticketId: unknown;
  lines: TicketLineInput[];
  discountIqd: number;
  totalIqd: number;
  customerName?: unknown;
  deviceReportedAt: unknown;
}

function ticketFingerprint(input: PosTicketInput): string {
  return hash(JSON.stringify({
    lines: input.lines.map((line) => [line.variantId, line.quantity, line.unitPriceIqd]),
    discountIqd: input.discountIqd,
    totalIqd: input.totalIqd,
  }));
}

/** Receipt numbers are per-device and readable: POS-A7K2-M3X9F2. */
function posOrderNumber(deviceShort: string): string {
  return `POS-${deviceShort}-${Date.now().toString(36).toUpperCase()}${crypto.randomInt(36 ** 2).toString(36).toUpperCase().padStart(2, "0")}`;
}

export async function ingestPosTicket(storeId: string, actor: { kind: "merchant" | "staff"; id: string }, input: PosTicketInput) {
  // ---- shape and arithmetic, before any transaction ----
  if (typeof input.deviceId !== "string" || typeof input.ticketId !== "string") {
    throw new HttpError(422, "INVALID_TICKET", "معرّف الجهاز ومعرّف التذكرة مطلوبان.");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
    throw new HttpError(422, "INVALID_TICKET", "البيعة تحتاج سطراً واحداً على الأقل، ومئة كحدّ أقصى.");
  }
  for (const line of input.lines) {
    const ok = typeof line.variantId === "string"
      && Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= 10_000
      && Number.isInteger(line.unitPriceIqd) && line.unitPriceIqd >= 0 && line.unitPriceIqd <= 1_000_000_000;
    if (!ok) throw new HttpError(422, "INVALID_TICKET_LINE", "سطر بيع غير صالح: الكمية عدد موجب والسعر عدد صحيح غير سالب.");
  }
  // INT4 is the money columns' ceiling. A ticket whose arithmetic is
  // internally consistent but exceeds it would pass every check and then die
  // at INSERT with a non-retryable 500 — and an idempotent till would replay
  // that poison ticket forever. Refused here as a 422 the till can surface.
  const INT4_MAX_SAFE = 2_000_000_000;
  for (const line of input.lines) {
    if (line.quantity * line.unitPriceIqd > INT4_MAX_SAFE) {
      throw new HttpError(422, "INVALID_TICKET_LINE", "قيمة السطر تتجاوز الحدّ الأقصى المسموح — قسّم البيعة.");
    }
  }
  const subtotalIqd = input.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceIqd, 0);
  if (subtotalIqd > INT4_MAX_SAFE) {
    throw new HttpError(422, "INVALID_TICKET", "إجمالي التذكرة يتجاوز الحدّ الأقصى المسموح — قسّم البيعة.");
  }
  const discountIqd = Number.isInteger(input.discountIqd) && input.discountIqd >= 0 ? input.discountIqd : NaN;
  // The server recomputes the arithmetic and refuses a ticket that disagrees
  // with itself. It does NOT re-price against today's catalog: an offline sale
  // rung at yesterday's price is a real sale at a real price, and the paper
  // receipt in the customer's hand is the document of record. Arithmetic is
  // ours to enforce; history is not ours to rewrite.
  if (!Number.isInteger(discountIqd) || discountIqd > subtotalIqd) {
    throw new HttpError(422, "INVALID_TICKET", "الخصم يجب أن يكون عدداً صحيحاً لا يتجاوز مجموع الأسطر.");
  }
  if (input.totalIqd !== subtotalIqd - discountIqd) {
    throw new HttpError(422, "TICKET_TOTALS_MISMATCH", "إجمالي التذكرة لا يساوي مجموع أسطرها بعد الخصم — أعد المحاولة من الكاشير.");
  }
  const deviceReportedAt = typeof input.deviceReportedAt === "string" ? new Date(input.deviceReportedAt) : new Date(NaN);
  if (Number.isNaN(deviceReportedAt.valueOf())) {
    throw new HttpError(422, "INVALID_TICKET", "وقت الجهاز مطلوب بصيغة ISO.");
  }
  // ---- sale time, bounded (POS offline v1) ----
  //
  // soldAt is when the cash changed hands per the till's clock — the axis the
  // POS takings aggregates key on, so an offline Monday sale flushed Tuesday
  // lands in Monday. But a till clock can lie, and no skew guard exists
  // anywhere else, so the server clamps the claim into [now − 30d, now]
  // before it can touch the stats: clock lies are BOUNDED without rewriting
  // the evidence — pos_tickets.device_reported_at keeps the raw value
  // exactly as sent. createdAt stays sync time, untouched.
  const ingestNow = new Date();
  const soldAtFloor = ingestNow.valueOf() - 30 * 24 * 60 * 60 * 1000;
  const soldAt = new Date(Math.min(Math.max(deviceReportedAt.valueOf(), soldAtFloor), ingestNow.valueOf()));
  const customerName = typeof input.customerName === "string" && input.customerName.trim()
    ? input.customerName.trim().slice(0, 120)
    : "زبون المحل";
  const fingerprint = ticketFingerprint(input);
  const deviceId = input.deviceId;
  const ticketId = input.ticketId;

  // ---- the transaction, Serializable with the storefront's retry loop ----
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const device = await tx.posDevice.findFirst({
          where: { id: deviceId, storeId },
          select: { id: true, deviceShort: true, revokedAt: true },
        });
        // 404 for a foreign device, not 403: whether a device id exists in
        // ANOTHER store is not this caller's to learn (store isolation).
        if (!device) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الجهاز غير موجود في هذا المتجر.");

        // ---- replay FIRST, revocation second ----
        //
        // Order matters. A sale can commit server-side while its response is
        // lost, and the till can then be revoked (replaced, stolen) BEFORE it
        // re-syncs. If revocation blocked the replay, that recorded sale could
        // never be acknowledged — and the natural human response, re-ringing
        // it on the new till with a fresh ticket id, would sell it twice.
        // Acknowledging an EXISTING sale is not the act revocation guards.
        const prior = await tx.posTicket.findUnique({
          where: { storeId_deviceId_ticketId: { storeId, deviceId, ticketId } },
          include: { order: { include: { items: true } }, shortfalls: { select: { variantId: true, shortfallQty: true } } },
        });
        if (prior) {
          if (prior.status === "succeeded" && prior.order) {
            // Same ticket id with DIFFERENT contents is not a retry — it is a
            // bug on the till or an attempt to reuse an id. Refuse loudly.
            if (prior.requestFingerprint !== fingerprint) {
              throw new HttpError(409, "TICKET_REUSED", "معرّف التذكرة استُعمل سابقاً لبيعة مختلفة.");
            }
            // The PERSISTED shortfalls ride the replay. The replay path exists
            // precisely for the case where the original response was lost —
            // which is exactly the case where the clamp warning was lost too.
            return {
              order: prior.order,
              replayed: true,
              shortfalls: prior.shortfalls.map((row) => ({ variantId: row.variantId, shortfallQty: row.shortfallQty })),
            };
          }
          // A prior attempt died mid-flight ('processing') or failed. The safe
          // answer is a clean retry under a fresh row — delete the husk. The
          // UNIQUE constraint still serialises concurrent racers.
          await tx.posTicket.delete({ where: { id: prior.id } });
        }

        if (device.revokedAt) throw new HttpError(403, "DEVICE_REVOKED", "هذا الجهاز أُلغي ربطه. اربط جهازاً جديداً من إعدادات المتجر.");

        const ticket = await tx.posTicket.create({
          data: { storeId, deviceId, ticketId, requestFingerprint: fingerprint, status: "processing", deviceReportedAt },
        });

        // ---- validate the lines against THIS store's catalog ----
        // Indexed dedupe, not a Set spread: this file is reachable from BOTH
        // tsconfigs and the root one rejects iterating a Set — the same
        // two-gate asymmetry the TOTP and password-policy work hit.
        const variantIds = input.lines.map((line) => line.variantId).filter((id, index, all) => all.indexOf(id) === index);
        const variants = await tx.productVariant.findMany({
          // LIVE: a variant sitting in the trash bin must not be sellable from
          // the till — PG-2's leak guard is what caught this query without it.
          // A product merely switched OFF (isActive false, not trashed) still
          // rings up ON PURPOSE: «off» hides it from the online shelves, but the
          // till sells what is physically on the counter, and an offline device
          // may scan it before the switch reaches it.
          where: { id: { in: variantIds }, storeId, ...LIVE, product: { is: LIVE } },
          select: { id: true, productId: true, sku: true, name: true, isDefault: true, priceIqd: true, stockQuantity: true, lowStockThreshold: true, product: { select: { name: true, isActive: true } } },
        });
        const variantById = new Map(variants.map((variant) => [variant.id, variant]));
        for (const line of input.lines) {
          if (!variantById.has(line.variantId)) {
            throw new HttpError(422, "VARIANT_NOT_FOUND", "أحد الأصناف غير موجود في هذا المتجر.");
          }
        }

        // ---- the order: born completed, born paid, cash, no courier ----
        const order = await tx.storeOrder.create({
          data: {
            storeId,
            orderNumber: posOrderNumber(device.deviceShort),
            status: "completed",
            paymentStatus: "paid",
            // "cash", NOT "cod": ق-135 hangs the no-commission rule off the
            // channel, and the reports separate «مبيعات المحل» by exactly this.
            paymentMethodCode: "cash",
            source: "pos",
            customerName,
            subtotalIqd,
            discountIqd,
            deliveryFeeIqd: 0,
            totalIqd: subtotalIqd - discountIqd,
            // The clamped sale time (see above). createdAt keeps its
            // @default(now()) — sync time and sale time are different facts.
            soldAt,
            updatedByKind: actor.kind,
            items: {
              create: input.lines.map((line) => {
                const variant = variantById.get(line.variantId)!;
                return {
                  productId: variant.productId,
                  variantId: variant.id,
                  sku: variant.sku,
                  productName: variant.product.name,
                  variantName: variant.name,
                  quantity: line.quantity,
                  unitPriceIqd: line.unitPriceIqd,
                  lineTotalIqd: line.quantity * line.unitPriceIqd,
                };
              }),
            },
            // Born completed is still a HISTORY, not an absence of one: the
            // immutable status-events trail records the birth the same way the
            // storefront records `null → new`.
            statusEvents: {
              create: { storeId, fromStatus: null, toStatus: "completed", actorKind: actor.kind, actorId: actor.id, note: null },
            },
          },
          include: { items: true },
        });

        // ---- stock: decrement what is truly free, clamp, record loudly ----
        //
        // THE NUMBER THAT MATTERS IS NOT stockQuantity. The storefront does not
        // decrement at checkout — it writes ACTIVE InventoryReservation rows
        // and decrements only at completion, with a guard that THROWS if the
        // stock is gone (settleStorefrontReservations). A till that spends raw
        // stockQuantity therefore sells units already promised to a shopper
        // whose courier may be en route — and when that order is delivered and
        // marked completed, the completion fails FOREVER, freezing the order
        // and the merchant's wallet credit for it. The review panel rated this
        // the one critical finding, and it is: the till may only spend
        //   stockQuantity − SUM(active reservations).
        const shortfalls: { variantId: string; shortfallQty: number }[] = [];
        // Aggregated per variant first: two lines of the same variant must
        // decrement once with their sum, or the clamp math splits wrongly.
        const perVariant = new Map<string, number>();
        for (const line of input.lines) {
          perVariant.set(line.variantId, (perVariant.get(line.variantId) ?? 0) + line.quantity);
        }
        const orderedVariantIds = Array.from(perVariant.keys());
        const reserved = await tx.inventoryReservation.groupBy({
          by: ["variantId"],
          where: { storeId, variantId: { in: orderedVariantIds }, status: "active" },
          _sum: { quantity: true },
        });
        const reservedByVariant = new Map(reserved.map((row) => [row.variantId, row._sum.quantity ?? 0]));
        // SORTED lock order, exactly as the storefront sorts before locking:
        // two tills touching [V1,V2] and [V2,V1] must acquire in one order or
        // they deadlock each other a second at a time.
        orderedVariantIds.sort();
        for (const variantId of orderedVariantIds) {
          const quantity = perVariant.get(variantId)!;
          const variant = variantById.get(variantId)!;
          const reservedQty = reservedByVariant.get(variantId) ?? 0;
          const decremented = await tx.productVariant.updateMany({
            // gte quantity + reserved: the decrement may only touch the slice
            // no shopper holds a claim on.
            where: { id: variantId, storeId, stockQuantity: { gte: quantity + reservedQty } },
            data: { stockQuantity: { decrement: quantity } },
          });
          if (decremented.count === 1) {
            await tx.inventoryMovement.create({
              data: { storeId, productId: variant.productId, variantId, delta: -quantity, reason: "pos_sale" },
            });
            await enqueueLowStockIfCrossed(tx, {
              storeId, productId: variant.productId, variantId,
              productName: variant.product.name, variantName: variant.name, sku: variant.sku,
              previousQuantity: variant.stockQuantity,
              stockQuantity: variant.stockQuantity - quantity,
              lowStockThreshold: variant.lowStockThreshold,
            });
            continue;
          }
          // The shelf (minus reservations) cannot cover the sale. The sale
          // already happened — spend only the unreserved slice, keep every
          // reserved unit intact for the shopper who holds it, and record the
          // gap where the merchant will see it.
          const current = await tx.productVariant.findFirst({ where: { id: variantId, storeId, ...LIVE }, select: { stockQuantity: true } });
          const stockNow = current?.stockQuantity ?? 0;
          const available = Math.max(0, stockNow - reservedQty);
          if (available > 0) {
            await tx.productVariant.updateMany({
              where: { id: variantId, storeId, stockQuantity: { gte: available } },
              data: { stockQuantity: { decrement: available } },
            });
            await tx.inventoryMovement.create({
              data: { storeId, productId: variant.productId, variantId, delta: -available, reason: "pos_sale" },
            });
          }
          // The clamp is the LOUDEST stock event there is — the alert must not
          // be the one thing the clamp path forgets.
          await enqueueLowStockIfCrossed(tx, {
            storeId, productId: variant.productId, variantId,
            productName: variant.product.name, variantName: variant.name, sku: variant.sku,
            previousQuantity: stockNow,
            stockQuantity: stockNow - available,
            lowStockThreshold: variant.lowStockThreshold,
          });
          await tx.posTicketShortfall.create({
            data: { storeId, posTicketId: ticket.id, variantId, soldQty: quantity, availableQty: available, shortfallQty: quantity - available },
          });
          shortfalls.push({ variantId, shortfallQty: quantity - available });
        }

        // ---- price deviations: the till's prices beside the catalog's ----
        await tx.posPriceDeviation.createMany({
          data: priceDeviationsFor(input.lines, variantById, discountIqd, subtotalIqd).map((row) => ({ ...row, storeId, posTicketId: ticket.id })),
        });

        // NO LEDGER ENTRY — deliberate, load-bearing, ق-135. See the header.

        await tx.posTicket.update({ where: { id: ticket.id }, data: { status: "succeeded", orderId: order.id } });

        return { order, replayed: false, shortfalls };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).then((result) => {
        // After commit; a replayed offline ticket announces nothing.
        if (!result.replayed && result.order) domainEvents.emit("order.pos_sale_recorded", { storeId, orderId: result.order.id, orderNumber: result.order.orderNumber, totalIqd: result.order.totalIqd });
        return result;
      });
    } catch (error) {
      // ق-132's principle decides this line: the till must not refuse. Six
      // jittered attempts instead of three instant ones, and P2028 (transaction
      // timeout) now counts as a lost race like the rest — see
      // src/db/serializable-retry.ts for why the old shape burned its budget in
      // a millisecond.
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && isRetryableTransactionError(error)) {
        await sleepBeforeRetry(attempt);
        continue;
      }
      throw error;
    } finally {
      // OUTSIDE the Serializable transaction, best-effort, and last: every
      // fresh sale used to write this one shared device row inside the
      // transaction, which made any two concurrent sales from the SAME till a
      // guaranteed write-write conflict — an offline queue flushing eight
      // sales in parallel burned its whole retry budget on telemetry.
      void prisma.posDevice.updateMany({ where: { id: deviceId, storeId }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- returns

/**
 * A POS SALE RETURNED IS STOCK BACK ON THE SHELF — at once, no inspection.
 *
 * The customer is standing at the counter with the goods; the cashier can see
 * them. So unlike a storefront return (refused at the door, inspected later),
 * the units go straight back — the owner's decision. Before this, `completed →
 * returned` on a POS order touched no stock at all (`settleStorefrontReservations`
 * steps aside for anything that is not a storefront order), so every counter
 * return was a silent loss of inventory.
 *
 * EXACTLY WHAT THE SALE TOOK, NOT WHAT IT SOLD. A sale that oversold the shelf
 * clamped at zero and recorded the gap as a shortfall; it decremented only
 * `soldQty − shortfallQty`. Giving back the full sold quantity would mint the
 * shortfall as stock nobody ever counted. The shortfall queue stays the ONE
 * place that gap is reconciled, so this returns the sale's own decrement and
 * the recorded stock nets to zero, as if the sale had not happened.
 *
 * A variant in the trash bin is refused, the inspection queue's rule
 * (`return-inspection.service.ts`): restoring onto a trashed variant is restoring
 * onto a row soft-delete owns. The merchant restores it first, then returns.
 *
 * Called inside the transition's own transaction, so the stock and the status
 * commit together; `returned` is terminal, so it runs once per order.
 */
export async function restockPosReturn(tx: Prisma.TransactionClient, storeId: string, orderId: string) {
  const items = await tx.orderItem.findMany({ where: { orderId, order: { storeId } }, select: { productId: true, variantId: true, quantity: true } });
  const ticket = await tx.posTicket.findFirst({ where: { storeId, orderId }, select: { shortfalls: { select: { variantId: true, shortfallQty: true } } } });
  const taken = new Map<string, { productId: string; quantity: number }>();
  for (const item of items) {
    if (!item.variantId || !item.productId) continue;
    const entry = taken.get(item.variantId) ?? { productId: item.productId, quantity: 0 };
    entry.quantity += item.quantity;
    taken.set(item.variantId, entry);
  }
  for (const shortfall of ticket?.shortfalls ?? []) {
    const entry = taken.get(shortfall.variantId);
    if (entry) entry.quantity -= shortfall.shortfallQty;
  }
  // Sorted, the lock order every other stock writer uses.
  for (const variantId of Array.from(taken.keys()).sort()) {
    const { productId, quantity } = taken.get(variantId)!;
    if (quantity <= 0) continue;
    const restored = await tx.productVariant.updateMany({
      where: { id: variantId, storeId, deletedAt: null },
      data: { stockQuantity: { increment: quantity } },
    });
    if (restored.count !== 1) throw new HttpError(409, "VARIANT_TRASHED", "أحد أصناف هذه البيعة في سلة المحذوفات — استرجعه أولاً ثم أرجِع البيعة.");
    await tx.inventoryMovement.create({ data: { storeId, productId, variantId, delta: quantity, reason: "pos_returned_restored" } });
  }
}

// ---------------------------------------------------------------- price deviations

/**
 * WHAT THE TILL CHARGED, BESIDE WHAT THE CATALOG SAYS.
 *
 * The till is trusted with its own prices — an offline sale rung at
 * yesterday's price is a real sale, and the server never re-prices it (see
 * `ingestPosTicket`). That trust had no one checking it: a cashier could ring a
 * line at 0, or discount a ticket to nothing, and keep the cash, and the order
 * recorded it faithfully where no screen ever compared it to anything.
 *
 * So every line whose unit price differs from the variant's CURRENT catalog
 * price is written down, in either direction, and so is every ticket-level
 * discount. Recorded, never refused — the shortfall queue's rule, applied to
 * money. A deviation is a question for the owner, not an accusation: the
 * catalog may have changed after an offline sale was rung, and the screen says
 * so.
 *
 * `amountIqd` is the size of the gap. The money columns are INT4 and a line can
 * be sold at 0 against a catalog price × quantity past that ceiling, so it is
 * capped at the column's maximum rather than failing the sale.
 */
const INT4_MAX = 2_147_483_647;
type DeviationRow = { variantId: string | null; kind: "price_below_catalog" | "price_above_catalog" | "ticket_discount"; quantity: number; soldUnitPriceIqd: number; catalogUnitPriceIqd: number; amountIqd: number };

export function priceDeviationsFor(lines: TicketLineInput[], variantById: Map<string, { priceIqd: number }>, discountIqd: number, subtotalIqd: number): DeviationRow[] {
  const rows: DeviationRow[] = [];
  for (const line of lines) {
    const catalog = variantById.get(line.variantId)?.priceIqd;
    if (catalog === undefined || catalog === line.unitPriceIqd) continue;
    rows.push({
      variantId: line.variantId,
      kind: line.unitPriceIqd < catalog ? "price_below_catalog" : "price_above_catalog",
      quantity: line.quantity,
      soldUnitPriceIqd: line.unitPriceIqd,
      catalogUnitPriceIqd: catalog,
      amountIqd: Math.min(INT4_MAX, Math.abs(catalog - line.unitPriceIqd) * line.quantity),
    });
  }
  if (discountIqd > 0) {
    rows.push({ variantId: null, kind: "ticket_discount", quantity: 1, soldUnitPriceIqd: subtotalIqd - discountIqd, catalogUnitPriceIqd: subtotalIqd, amountIqd: discountIqd });
  }
  return rows;
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const PRICE_DEVIATIONS_KIND = "merchant.pos.price_deviations";

/** The open queue, newest first, with the sale each row came from. */
export async function listPosPriceDeviations(storeId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(PRICE_DEVIATIONS_KIND, rawCursor);
  const rows = await prisma.posPriceDeviation.findMany({
    where: { storeId, reviewedAt: null, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, kind: true, quantity: true, soldUnitPriceIqd: true, catalogUnitPriceIqd: true, amountIqd: true, createdAt: true,
      variant: { select: { sku: true, name: true, product: { select: { name: true } } } },
      ticket: { select: { order: { select: { orderNumber: true, soldAt: true, statusEvents: { select: { actorKind: true, actorId: true }, orderBy: { createdAt: "asc" }, take: 1 } } }, device: { select: { label: true } } } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(PRICE_DEVIATIONS_KIND, last.createdAt, last.id));
  // Who rang it: the actor on the sale's birth event. A name, not an id — the
  // owner reading this queue is asking «which of my people», and a staff row
  // keeps its name after the membership ends.
  const sellerOf = (row: (typeof page)[number]) => row.ticket.order?.statusEvents[0] ?? null;
  const staffIds = Array.from(new Set(page.map(sellerOf).filter((seller) => seller?.actorKind === "staff" && seller.actorId).map((seller) => seller!.actorId!)));
  const staffNames = new Map((staffIds.length ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, displayName: true } }) : []).map((staff) => [staff.id, staff.displayName]));
  return {
    deviations: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      quantity: row.quantity,
      soldUnitPriceIqd: row.soldUnitPriceIqd,
      catalogUnitPriceIqd: row.catalogUnitPriceIqd,
      amountIqd: row.amountIqd,
      createdAt: row.createdAt,
      productName: row.variant?.product.name ?? null,
      variantName: row.variant?.name ?? null,
      sku: row.variant?.sku ?? null,
      orderNumber: row.ticket.order?.orderNumber ?? null,
      soldAt: row.ticket.order?.soldAt ?? null,
      deviceLabel: row.ticket.device?.label ?? null,
      soldBy: (() => {
        const seller = sellerOf(row);
        if (!seller) return null;
        return { kind: seller.actorKind, name: seller.actorKind === "staff" ? staffNames.get(seller.actorId ?? "") ?? null : null };
      })(),
    })),
    nextCursor,
  };
}

export async function reviewPosPriceDeviation(storeId: string, deviationId: string) {
  const result = await prisma.posPriceDeviation.updateMany({
    where: { id: deviationId, storeId, reviewedAt: null },
    data: { reviewedAt: new Date() },
  });
  if (result.count === 0) {
    const exists = await prisma.posPriceDeviation.findFirst({ where: { id: deviationId, storeId }, select: { id: true } });
    if (!exists) throw new HttpError(404, "RESOURCE_NOT_FOUND", "السجل غير موجود.");
  }
}

// ---------------------------------------------------------------- shortfalls

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const SHORTFALLS_KIND = "merchant.pos.shortfalls";

/**
 * D-18: capped at 200 unreviewed shortfalls with no page 2. A till that has
 * been oversold through a bad week buries its own oldest discrepancies —
 * which are the ones whose stock count is furthest from the truth.
 */
export async function listPosShortfalls(storeId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(SHORTFALLS_KIND, rawCursor);
  const rows = await prisma.posTicketShortfall.findMany({
    where: { storeId, reviewedAt: null, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, soldQty: true, availableQty: true, shortfallQty: true, createdAt: true,
      variant: { select: { sku: true, name: true, product: { select: { name: true } } } },
      ticket: { select: { order: { select: { orderNumber: true } } } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(SHORTFALLS_KIND, last.createdAt, last.id));
  return { shortfalls: page, nextCursor };
}

export async function reviewPosShortfall(storeId: string, shortfallId: string) {
  const result = await prisma.posTicketShortfall.updateMany({
    where: { id: shortfallId, storeId, reviewedAt: null },
    data: { reviewedAt: new Date() },
  });
  if (result.count === 0) {
    const exists = await prisma.posTicketShortfall.findFirst({ where: { id: shortfallId, storeId }, select: { id: true } });
    if (!exists) throw new HttpError(404, "RESOURCE_NOT_FOUND", "السجل غير موجود.");
  }
}
