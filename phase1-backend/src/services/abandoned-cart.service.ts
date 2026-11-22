/**
 * codiq phase 20B-2 — abandoned-cart recovery (D-24), merchant-facing side.
 *
 * Honest definition (plan §3): an abandoned cart is an `active` cart WITH items
 * whose last activity is older than the store's window and that never
 * converted. Recovery messages go ONLY to registered customers with an email —
 * guests carry no contact channel, so they are counted statistically and the UI
 * states that plainly.
 *
 * The opt-in flag and its configuration live as ONE coherent block under
 * notification_settings.configuration.abandonedCart = { enabled, windowHours,
 * recoveryCouponId }. It is deliberately NOT inside the legacy `preferences`
 * trio: the phase-15 contract (and its strict deepEqual assertions) pins that
 * object to exactly {orderCreated, orderStatusChanged, lowStock}, and this is a
 * marketing preference with its own validated payload, not another boolean.
 * Default is OFF (approved decision §8.7 — marketing messages are opt-in).
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { LIVE } from "./soft-delete/constants.js";

export const ABANDONED_CART_DEFAULT_WINDOW_HOURS = 12;
export const ABANDONED_CART_MIN_WINDOW_HOURS = 1;
export const ABANDONED_CART_MAX_WINDOW_HOURS = 72;

export interface AbandonedCartSettings {
  enabled: boolean;
  windowHours: number;
  recoveryCouponId: string | null;
}

/** Tolerant read of configuration.abandonedCart with the approved defaults (§8.6/§8.7). */
export function normalizeAbandonedCartSettings(configuration: unknown): AbandonedCartSettings {
  const raw = (configuration ?? {}) as Record<string, unknown>;
  const stored = (raw.abandonedCart ?? {}) as Record<string, unknown>;
  const window = Number(stored.windowHours);
  return {
    enabled: stored.enabled === true,
    windowHours:
      Number.isInteger(window) && window >= ABANDONED_CART_MIN_WINDOW_HOURS && window <= ABANDONED_CART_MAX_WINDOW_HOURS
        ? window
        : ABANDONED_CART_DEFAULT_WINDOW_HOURS,
    recoveryCouponId: typeof stored.recoveryCouponId === "string" && stored.recoveryCouponId ? stored.recoveryCouponId : null,
  };
}

export async function abandonedCartSettingsView(storeId: string) {
  const settings = await prisma.notificationSettings.findUnique({ where: { storeId }, select: { isEnabled: true, configuration: true } });
  const normalized = normalizeAbandonedCartSettings(settings?.configuration);
  const coupon = normalized.recoveryCouponId
    ? await prisma.coupon.findFirst({ where: { id: normalized.recoveryCouponId, storeId, ...LIVE }, select: { code: true, isActive: true } })
    : null;
  return {
    masterEnabled: settings?.isEnabled === true,
    enabled: normalized.enabled,
    windowHours: normalized.windowHours,
    recoveryCouponId: normalized.recoveryCouponId,
    recoveryCouponCode: coupon?.code ?? null,
    recoveryCouponActive: coupon?.isActive ?? null,
  };
}

/**
 * settings.manage write path. windowHours is validated to the approved 1–72
 * range (§8.6) and recoveryCouponId must reference an ACTIVE coupon of the SAME
 * store — a foreign or retired coupon is a 422, never silently accepted.
 * Other configuration keys (the phase-15 preferences) are preserved untouched.
 */
export async function updateAbandonedCartSettings(storeId: string, body: Record<string, unknown>) {
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new HttpError(422, "INVALID_INPUT", "التفعيل نعم أو لا.");
  }
  if (body.windowHours !== undefined) {
    const window = typeof body.windowHours === "number" ? body.windowHours : Number(body.windowHours);
    if (!Number.isInteger(window) || window < ABANDONED_CART_MIN_WINDOW_HOURS || window > ABANDONED_CART_MAX_WINDOW_HOURS) {
      throw new HttpError(422, "INVALID_ABANDONED_CART_WINDOW", `مهلة السلة المتروكة عدد صحيح من ${ABANDONED_CART_MIN_WINDOW_HOURS} إلى ${ABANDONED_CART_MAX_WINDOW_HOURS} ساعة.`);
    }
  }
  if (body.recoveryCouponId !== undefined && body.recoveryCouponId !== null && body.recoveryCouponId !== "") {
    if (typeof body.recoveryCouponId !== "string") throw new HttpError(422, "INVALID_RECOVERY_COUPON", "كوبون الاسترجاع غير صالح.");
    const coupon = await prisma.coupon.findFirst({ where: { id: body.recoveryCouponId, storeId, ...LIVE }, select: { isActive: true } });
    if (!coupon || !coupon.isActive) throw new HttpError(422, "INVALID_RECOVERY_COUPON", "كوبون الاسترجاع يجب أن يكون كوبوناً فعّالاً من هذا المتجر.");
  }

  const current = await prisma.notificationSettings.findUnique({ where: { storeId }, select: { configuration: true } });
  const currentConfiguration = (current?.configuration ?? {}) as Record<string, unknown>;
  const existing = normalizeAbandonedCartSettings(currentConfiguration);
  const next: AbandonedCartSettings = {
    enabled: body.enabled !== undefined ? (body.enabled as boolean) : existing.enabled,
    windowHours: body.windowHours !== undefined ? Number(body.windowHours) : existing.windowHours,
    recoveryCouponId:
      body.recoveryCouponId === undefined
        ? existing.recoveryCouponId
        : body.recoveryCouponId === null || body.recoveryCouponId === ""
          ? null
          : (body.recoveryCouponId as string),
  };
  await prisma.notificationSettings.upsert({
    where: { storeId },
    create: { storeId, isEnabled: false, configuration: { abandonedCart: { ...next } } },
    update: { configuration: { ...currentConfiguration, abandonedCart: { ...next } } },
  });
  return abandonedCartSettingsView(storeId);
}

/**
 * customers.view read path for the panel: the live abandoned list (customers
 * AND guests — guests statistically only) plus the honest stats:
 * sent = cart.abandoned outbox rows for this store, recovered = those rows
 * whose cart later converted. Recovery is a CORRELATION («تحوّلت بعد الرسالة»),
 * never a causal claim — the UI copy keeps that wording.
 */
/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const ABANDONED_CARTS_KIND = "merchant.abandoned-carts";

/**
 * D-18: capped at 100 carts with no page 2. A busy shop abandons more than that
 * in a day, and the merchant could never reach the older ones — the recovery
 * list is the whole point of the screen.
 */
export async function abandonedCartsPanel(storeId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(ABANDONED_CARTS_KIND, rawCursor);
  const settings = await prisma.notificationSettings.findUnique({ where: { storeId }, select: { configuration: true } });
  const { windowHours } = normalizeAbandonedCartSettings(settings?.configuration);
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const [carts, sent, recovered] = await Promise.all([
    prisma.shoppingCart.findMany({
      where: { storeId, status: "active", lastActivityAt: { lt: cutoff }, items: { some: {} }, ...keysetWhere("lastActivityAt", "desc", cursor) },
      select: {
        id: true,
        ownerKind: true,
        lastActivityAt: true,
        customer: { select: { fullName: true, email: true } },
        items: { select: { quantity: true, priceSnapshotIqd: true } },
        notificationOutbox: { where: { eventType: "cart.abandoned" }, select: { id: true, status: true, createdAt: true }, take: 1 },
      },
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    // A cart message references a cart by definition — rows without cartId
    // (defensive/manual inserts) never count as sent recovery messages.
    prisma.notificationOutbox.count({ where: { storeId, eventType: "cart.abandoned", cartId: { not: null } } }),
    prisma.notificationOutbox.count({ where: { storeId, eventType: "cart.abandoned", cart: { status: "converted" } } }),
  ]);
  const { page, nextCursor } = pageOf(carts, limit, (last) => encodeListCursor(ABANDONED_CARTS_KIND, last.lastActivityAt, last.id));
  return {
    windowHours,
    nextCursor,
    carts: page.map((cart) => ({
      id: cart.id,
      ownerKind: cart.ownerKind,
      customerName: cart.customer?.fullName ?? null,
      hasEmail: Boolean(cart.customer?.email),
      itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
      totalIqd: cart.items.reduce((sum, item) => sum + item.quantity * item.priceSnapshotIqd, 0),
      lastActivityAt: cart.lastActivityAt,
      message: cart.notificationOutbox[0] ? { status: cart.notificationOutbox[0].status, createdAt: cart.notificationOutbox[0].createdAt } : null,
    })),
    stats: { sent, recovered },
  };
}
