/**
 * Phase 19-ج — the order-side legacy routes in `routes/orders.ts` (ق-49).
 *
 * The dividing line is the one `http/validate.ts` states: shape at the edge,
 * meaning in the service. In this file it lands in an unusually visible place,
 * because four of these five surfaces already answer with a NAMED, asserted
 * code — `INVALID_ORDER_NOTE`, `INVALID_ORDER_TAGS`, `INVALID_ORDER_STATUS`,
 * `INVALID_BULK_SELECTION`, `INVALID_PRESCRIPTION_DECISION`. Those codes are the
 * contract md1, phase9A and 20B-1 assert and the order workspace renders, so
 * they stay exactly where they are; the schema takes only the question the
 * service was answering by accident — «is this a string / a number / an array».
 *
 * Read the bounds that are ABSENT here as deliberate:
 *   · no `.max(2000)` on a note — the 2000-character cap is `order-notes.service`'s,
 *     and it answers `INVALID_ORDER_NOTE`;
 *   · no `.max(8)` on tags and no `.min(1)` on a bulk selection — an empty
 *     selection is `INVALID_BULK_SELECTION` and a ninth tag is `INVALID_ORDER_TAGS`;
 *   · no `.enum()` on `toStatus` or `decision` — the status set is the state
 *     machine's, and «teleported» must keep answering `INVALID_ORDER_STATUS`.
 * Every one of those would have been a schema quietly RENAMING a refusal that a
 * merchant already reads on his screen.
 */
import { z } from "zod";

/**
 * Phase 17 delivery rates. The only surface here whose refusals were the generic
 * `INVALID_INPUT`, so it is the only one where the schema genuinely takes over.
 *
 * The «at least one of amountIqd or isEnabled» rule stays in the service on
 * purpose: it is a cross-field rule about what a PATCH means, and the house puts
 * those where the writer of the next field will see them (`return-inspection`
 * does the same with its split arithmetic). The ceiling stays there too, for
 * the same reason and because the number and its reasoning belong together.
 *
 * 19-د: this file used to record that there was NO upper bound, «because there
 * was none before — inventing one here would refuse a rate a merchant can set
 * today». The caution was right and the conclusion was not: the absent bound
 * left int4's 2,147,483,647 as the real ceiling, and a merchant could shift his
 * takings out of the commission base by pricing goods at 1,000 and delivery at
 * 99,000. `MAX_DELIVERY_RATE_IQD` is deliberately far above any genuine Iraqi
 * courier fee so that the original caution still holds — see the constant for
 * what it does and does not answer.
 */
export const updateDeliveryRateSchema = z.object({
  amountIqd: z.number().int().min(0).optional(),
  isEnabled: z.boolean().optional(),
});

/** 20B-1 prescription review. `reviewOrderPrescription` still owns the two legal values. */
export const reviewPrescriptionSchema = z.object({
  decision: z.string(),
});

/** MD-1 internal note. Trimming, the empty-note refusal and the cap stay in the service. */
export const createOrderNoteSchema = z.object({
  body: z.string(),
});

/**
 * MD-1 internal tags. `nullish` because an absent or null list has always meant
 * «no tags», not «a malformed request» — `normalizeOrderTags` answers both with
 * an empty set, and a route that started refusing them would break the tag
 * editor's own «clear all».
 */
export const replaceOrderTagsSchema = z.object({
  tags: z.array(z.string()).nullish(),
});

/**
 * MD-1 bulk transition. An entry is either an id or an `{ orderId }` row, and
 * `requestedOrderIds` is the one place that knows it — so the array is typed and
 * its CONTENTS are not.
 */
export const bulkOrderStatusSchema = z.object({
  orders: z.array(z.unknown()),
  toStatus: z.string(),
  // Service-owned: a non-string note is a 400 `INVALID_ORDER_NOTE`, refused once
  // up-front for the whole batch rather than fifty times.
  note: z.unknown().optional(),
});

/**
 * A single order's status transition. Deliberately mirrors `bulkOrderStatusSchema`:
 * `toStatus` and `note` stay `z.string()`/`z.unknown()` because their refusals are
 * the service's named codes — `INVALID_ORDER_STATUS` and `INVALID_ORDER_NOTE` —
 * which the merchant reads on screen. zod owns arrival and type; meaning stays
 * where the one definition of a valid transition already lives.
 *
 * This route was INVISIBLE to the adoption ratchet until its blind spot was
 * fixed: written on a single line, it had no `
  }));` of its own, so the
 * regex's span ran past it into a later route.
 */
export const transitionOrderStatusSchema = z.object({
  toStatus: z.string(),
  // `expectedVersion` is the optimistic-concurrency guard: two dashboards moving
  // the same order at once must not silently overwrite each other. It stays
  // `unknown` because the service owns its refusal — and it is NAMED here
  // rather than left out, because `z.object` strips what it does not name: a
  // schema that forgot this field would have deleted the collision check with
  // no test failing and no error anywhere. TypeScript caught exactly that.
  expectedVersion: z.unknown().optional(),
  note: z.unknown().optional(),
  // ق-246: the handover facts may ride the «قيد التوصيل» transition. Service-
  // owned like `note` — `parseDeliveryFields` refuses with INVALID_DELIVERY_FIELD.
  courierName: z.unknown().optional(),
  trackingNumber: z.unknown().optional(),
});

/** q-246: a handover correction. Meaning (lengths, which statuses admit it) is the service's. */
export const orderDeliverySchema = z.object({
  courierName: z.unknown().optional(),
  trackingNumber: z.unknown().optional(),
  expectedVersion: z.unknown().optional(),
});

/** q-246: "I received the cash" for a batch of delivered orders. The service caps and validates the ids. */
export const codCollectedSchema = z.object({
  orderIds: z.array(z.unknown()),
});

/** M6 (G5): the shopper's six-digit pick-up code, as the merchant types or scans it. */
export const pickupConfirmSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "رمز الاستلام ستّة أرقام") });
