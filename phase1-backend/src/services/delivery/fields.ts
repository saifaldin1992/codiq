/**
 * Delivery and cash on delivery — fields. Split verbatim from delivery.service.ts
 * (review batch 4, ت-٥); delivery.service.ts re-exports what it always exported.
 */
import { HttpError } from "../../auth/auth.errors.js";

export const COURIER_NAME_MAX_LENGTH = 120;

export const TRACKING_NUMBER_MAX_LENGTH = 120;

/** A reconciliation or manifest window may span at most this many days — a report, not a list. */
export const DELIVERY_WINDOW_MAX_DAYS = 62;

/** Suggested courier names come from the store's own recent handovers. */
export const COURIER_SUGGESTION_DAYS = 90;

export const MANIFEST_PAGE_SIZE = 200;

export const COD_COLLECT_BATCH_LIMIT = 200;

export type DeliveryActor = { kind: "merchant" | "staff"; id: string };

/** Optional text, trimmed; empty means «clear it». */
function optionalDeliveryText(
  value: unknown,
  field: string,
  max: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string")
    throw new HttpError(422, "INVALID_DELIVERY_FIELD", `${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max)
    throw new HttpError(
      422,
      "INVALID_DELIVERY_FIELD",
      `${field} must contain at most ${max} characters.`
    );
  return trimmed;
}

/**
 * The delivery fields a transition or a correction may carry. Parsed once,
 * here, so the transition and the PATCH refuse the same things the same way.
 */
export function parseDeliveryFields(body: Record<string, unknown>): {
  courierName?: string | null;
  trackingNumber?: string | null;
} {
  return {
    courierName: optionalDeliveryText(body.courierName, "courierName", COURIER_NAME_MAX_LENGTH),
    trackingNumber: optionalDeliveryText(
      body.trackingNumber,
      "trackingNumber",
      TRACKING_NUMBER_MAX_LENGTH
    ),
  };
}

/** The column subset every reader of the handover facts uses. */
export const deliverySelect = {
  courierName: true,
  trackingNumber: true,
  handedOverAt: true,
  codCollectedAt: true,
} as const;

export function windowFrom(query: Record<string, unknown>): {
  from: Date;
  to: Date;
  courier: string | null;
} {
  const parse = (value: unknown, field: string): Date | null => {
    if (value === undefined || value === "") return null;
    if (typeof value !== "string")
      throw new HttpError(422, "INVALID_DELIVERY_WINDOW", `${field} must be an ISO-8601 date.`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf()))
      throw new HttpError(422, "INVALID_DELIVERY_WINDOW", `${field} must be an ISO-8601 date.`);
    return parsed;
  };
  const now = new Date();
  const to = parse(query.to, "to") ?? now;
  // Default: the day that just happened — the manifest a courier collects in
  // the morning is yesterday evening's parcels plus today's.
  const from = parse(query.from, "from") ?? new Date(to.getTime() - 86_400_000);
  if (from > to) throw new HttpError(422, "INVALID_DELIVERY_WINDOW", "from must not be after to.");
  if (to.getTime() - from.getTime() > DELIVERY_WINDOW_MAX_DAYS * 86_400_000) {
    throw new HttpError(
      422,
      "INVALID_DELIVERY_WINDOW",
      `The window may span at most ${DELIVERY_WINDOW_MAX_DAYS} days.`
    );
  }
  const courier = optionalDeliveryText(query.courier, "courier", COURIER_NAME_MAX_LENGTH) ?? null;
  return { from, to, courier };
}

/**
 * Review batch 4, م-٢ — the cash the courier collects at the door: what is STILL OWED, not the
 * order total. A card or partner order was paid before it left the shelf; an instalment plan
 * paid the goods and left the delivery fee to be paid in cash (M13a). Everything else — cash on
 * delivery, a transfer nobody has confirmed — is the whole total.
 */
export function cashToCollectIqd(order: {
  paymentStatus: string;
  totalIqd: number;
  deliveryFeeIqd: number;
}): number {
  if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") return 0;
  if (order.paymentStatus === "instalments") return order.deliveryFeeIqd;
  return order.totalIqd;
}
