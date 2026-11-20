/**
 * PG-2 — one place that reads a foreign-key violation and says what it means.
 *
 * The purge job (plan §1.د) deliberately knows NOTHING about the ledger: it
 * attempts a `DELETE` per row and treats 23503 / P2003 as a NAMED OUTCOME
 * (`purge_blocked`), not an error. Everything financial or auditable is wired
 * with `Restrict` — `order_items`, `cart_items`, `inventory_reservations`,
 * `coupon_redemptions`, `store_orders.coupon_id`, `staff_sessions` — so Postgres
 * refuses it automatically, and ANY restricting foreign key added two years from
 * now is protected without its author ever learning the purge exists.
 *
 * The same table also backs the HTTP 409 branch in `http/errors.ts`: before
 * PG-2 a hard product delete that hit `cart_items` produced a bare 500.
 */
import { Prisma } from "@prisma/client";

/**
 * The constraint name behind a foreign-key violation. Prisma reports P2003 with
 * `meta.constraint` on recent versions and `meta.field_name` on older ones, and
 * a raw `$executeRaw` surfaces the same failure as a plain 23503 whose message
 * carries the name in quotes — all three are read here.
 */
export function foreignKeyConstraintName(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    const meta = (error.meta ?? {}) as { constraint?: unknown; field_name?: unknown };
    const named = typeof meta.constraint === "string" ? meta.constraint : Array.isArray(meta.constraint) ? meta.constraint.join(",") : undefined;
    if (named) return named;
    if (typeof meta.field_name === "string") return meta.field_name;
  }
  const raw = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (raw?.code === "23503") {
    if (typeof raw.constraint === "string") return raw.constraint;
    if (typeof raw.message === "string") {
      const quoted = raw.message.match(/constraint "([^"]+)"/);
      if (quoted) return quoted[1]!;
    }
  }
  if (error instanceof Error && error.message.includes("23503")) {
    const quoted = error.message.match(/constraint "([^"]+)"/);
    if (quoted) return quoted[1]!;
  }
  return null;
}

export function isForeignKeyViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return true;
  const raw = error as { code?: unknown };
  if (raw?.code === "23503") return true;
  return error instanceof Error && error.message.includes("23503");
}

type FkRule = { match: (constraint: string) => boolean; status: 409; code: string; message: string; reason: string };

/**
 * Ordered rules: the FIRST match wins, so the more specific table names come
 * before the generic ones. `reason` is the merchant-facing «محفوظ لسجلاتك»
 * explanation stamped on `purge_block_reason`; `code`/`message` are the HTTP
 * 409 the error handler returns for the same violation.
 */
const FK_RULES: FkRule[] = [
  {
    match: (name) => name.startsWith("cart_items"),
    status: 409,
    code: "PRODUCT_IN_ACTIVE_CART",
    message: "هذا المنتج موجود الآن في سلة زبون — لا يمكن حذفه نهائياً.",
    reason: "موجود في سلة زبون.",
  },
  {
    match: (name) => name.startsWith("inventory_reservations"),
    status: 409,
    code: "PRODUCT_HAS_ACTIVE_RESERVATION",
    message: "هذا المنتج عليه حجز مخزون لطلب قائم — لا يمكن حذفه نهائياً.",
    reason: "عليه حجز مخزون لطلب قائم.",
  },
  {
    match: (name) => name.startsWith("order_items"),
    status: 409,
    code: "PRODUCT_REFERENCED_BY_ORDER",
    message: "هذا المنتج مرتبط بطلبات — يُحفظ صفّه حفاظاً على سجل تلك الطلبات.",
    reason: "مباع في طلبات — محفوظ لسجلاتك.",
  },
  {
    match: (name) => name.startsWith("coupon_redemptions"),
    status: 409,
    code: "COUPON_REFERENCED_BY_REDEMPTION",
    message: "هذا الكوبون استُخدم في طلبات — يُحفظ صفّه حفاظاً على سجل تلك الطلبات.",
    reason: "استُرد في طلبات — محفوظ لسجلاتك.",
  },
  {
    match: (name) => name.startsWith("store_orders_coupon"),
    status: 409,
    code: "COUPON_REFERENCED_BY_ORDER",
    message: "هذا الكوبون مرتبط بطلبات — يُحفظ صفّه حفاظاً على سجل تلك الطلبات.",
    reason: "مرتبط بطلبات — محفوظ لسجلاتك.",
  },
  {
    match: (name) => name.startsWith("staff_sessions"),
    status: 409,
    code: "MEMBERSHIP_HAS_SESSIONS",
    message: "لهذه العضوية جلسات مسجّلة — لا يمكن حذفها نهائياً الآن.",
    reason: "لها جلسات مسجّلة.",
  },
  {
    // products.category_id → product_categories(id) ON DELETE RESTRICT.
    match: (name) => name.startsWith("products_category"),
    status: 409,
    code: "CATEGORY_IN_USE",
    message: "هذا التصنيف ما زال مرتبطاً بمنتجات — لا يمكن حذفه نهائياً.",
    reason: "ما زال تصنيفاً لمنتجات محفوظة.",
  },
  {
    match: (name) => name.startsWith("product_categories_parent"),
    status: 409,
    code: "CATEGORY_HAS_CHILDREN",
    message: "هذا التصنيف ما زال أباً لتصنيفات أخرى — لا يمكن حذفه نهائياً.",
    reason: "ما زال أباً لتصنيفات محفوظة.",
  },
];

const GENERIC_REASON = "مرتبط بسجلات أخرى — محفوظ لسجلاتك.";

export function fkRuleFor(constraint: string | null): FkRule | null {
  if (!constraint) return null;
  return FK_RULES.find((rule) => rule.match(constraint)) ?? null;
}

/**
 * The same reason string, addressable BEFORE any violation happens.
 *
 * The trash bin has to tell a merchant on DAY ONE that a sold product is never
 * going to be purged — waiting for the sweep to discover it on day 31 means the
 * bin spends the whole retention window promising a deletion that will not
 * happen, one screen after the confirmation sheet promised the opposite. Reading
 * the prediction out of THIS table is what stops the two sentences from drifting:
 * the badge the bin shows today and the one the sweep stamps later are the same
 * string from the same row.
 */
export function reasonForBlockingTable(table: "order_items" | "coupon_redemptions" | "store_orders_coupon" | "products_category"): string {
  return fkRuleFor(table)?.reason ?? GENERIC_REASON;
}

/** The merchant-facing «محفوظ لسجلاتك» explanation for a blocked purge. */
export function purgeBlockReason(error: unknown): string {
  const constraint = foreignKeyConstraintName(error);
  return fkRuleFor(constraint)?.reason ?? (constraint ? `${GENERIC_REASON} (${constraint})` : GENERIC_REASON);
}
