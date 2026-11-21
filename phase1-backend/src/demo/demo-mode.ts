/**
 * codiq P27-7 — demo environment mode (server-enforced).
 *
 * The demo is a FOURTH ENVIRONMENT fed by the same `main`, not a code fork, so it
 * stays in sync automatically. Everything that makes the demo safe is enforced on
 * the server behind one flag — `CODIQ_DEMO_MODE`, read once in `config.demoMode`.
 * Nothing here is a UI-only concession: hiding a button would leave the API open.
 *
 * Four guarantees live in this module:
 *  1. `demoBlockedSurfaceGuard` makes the entire platform-owner surface vanish —
 *     a plain 404 RESOURCE_NOT_FOUND, never a 403, so the demo does not even
 *     advertise that an owner area exists. It matches by PREFIX, so a platform
 *     route added later is blocked the day it is written.
 *  2. The same guard refuses merchant self-registration, but WITH a readable
 *     Arabic explanation instead of the silent 404 — see DEMO_REFUSED_PATHS.
 *  3. `assertDemoWritable` refuses the few mutations that would break the shared
 *     demo for the next visitor before the nightly reseed.
 *  4. The seeded identities below are the single source of truth shared by the
 *     seed script, the guest-entry endpoint, and the guard.
 *
 * Every export is inert when the flag is off: `assertDemoWritable` returns
 * immediately and the guard middleware is never registered.
 */
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../auth/auth.errors.js";
import { config } from "../config.js";

/**
 * The seeded demo identities. `scripts/seed-demo.ts` creates exactly these, the
 * guest-entry endpoint signs in as exactly this merchant, and `assertDemoWritable`
 * protects exactly these rows. Documented for prospects in docs/DEMO_ENVIRONMENT.md.
 */
export const DEMO_MERCHANT_EMAIL = "demo@codiq.iq";
export const DEMO_MERCHANT_PASSWORD = "CodiqDemo2026!";
export const DEMO_STORE_SLUG = "demo-store";
export const DEMO_STAFF_EMAIL = "staff.demo@codiq.iq";
export const DEMO_STAFF_PASSWORD = "CodiqDemoStaff2026!";

/**
 * Surfaces that do not exist at all in the demo. Matched as exact path or path
 * prefix on the API-relative path (the API is mounted under /api by the composite
 * server, and Express strips the mount before `request.path`).
 *
 * `/platform` covers routes/platform.ts (21 routes) plus the eight owner-facing
 * read routes registered in routes/orders.ts. `/auth/platform` covers owner login
 * and the bootstrap-only owner registration. Merchant-facing routes that happen to
 * be registered inside routes/platform.ts (`/merchant/subscription`,
 * `/merchant/finance/*`) are deliberately NOT matched — they are merchant surface.
 */
const DEMO_BLOCKED_PREFIXES = ["/platform", "/auth/platform"] as const;

/**
 * Compared CASE-INSENSITIVELY, because Express routes case-insensitively by
 * default (`case sensitive routing` is off, so `/api/Platform/plans` reaches the
 * very same handler as `/api/platform/plans`). A literal comparison here would
 * let a single capital letter walk past the guard and meet the real owner
 * routes — they answer 401 rather than the 404 this module promises, which
 * ADVERTISES that an owner area exists, and would become a genuine hole the day
 * `CODIQ_ALLOW_OWNER_REGISTRATION` was set on the demo service by mistake.
 *
 * Lower-casing the path (rather than `app.set("case sensitive routing", true)`)
 * keeps the fix local: flipping Express to case-sensitive routing would change
 * matching for every route in the application, not just these two prefixes.
 */
export function isDemoBlockedPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return DEMO_BLOCKED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

/**
 * Surfaces that are REFUSED WITH AN EXPLANATION rather than hidden.
 *
 * Self-registration is the one demo hazard that is not about secrecy: the form
 * is right there on the public marketing page, a prospect who trims the demo
 * link lands on it, and until now it SUCCEEDED — a real merchant account and
 * store, greeted with «تم إنشاء متجرك بنجاح!», silently destroyed by the 01:00
 * `TRUNCATE … CASCADE` with no notification possible (the demo forces the
 * notification provider to null). The visitor comes back to nothing.
 *
 * So it is blocked — but deliberately NOT with the silent 404 the owner surface
 * gets. Hiding a route the visitor cannot see protects them; hiding a form they
 * just clicked only confuses them. This answers in Arabic and sends them to the
 * real site. Matched case-insensitively for the same reason as the block list.
 */
const DEMO_REFUSED_PATHS = ["/public/merchants/register"] as const;

export const DEMO_REGISTRATION_REFUSAL =
  "هذه نسخة تجريبية للاستعراض فقط، وبياناتها تُمحى بالكامل كل ليلة — لذلك لا يمكن إنشاء حساب حقيقي فيها. للتسجيل الحقيقي انتقل إلى موقع Codiq الرسمي.";

export function isDemoRefusedPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return DEMO_REFUSED_PATHS.some((refused) => normalized === refused);
}

/** Registered only when `config.demoMode` is true; a no-op file otherwise. */
export function demoBlockedSurfaceGuard(request: Request, _response: Response, next: NextFunction) {
  if (isDemoBlockedPath(request.path)) {
    next(new HttpError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found."));
    return;
  }
  if (isDemoRefusedPath(request.path)) {
    next(new HttpError(403, "DEMO_REGISTRATION_DISABLED", DEMO_REGISTRATION_REFUSAL));
    return;
  }
  next();
}

/**
 * The rows a visitor must not be able to break for the next visitor. Kept
 * deliberately short: everything else (creating, editing and deleting products,
 * orders, coupons, customers, extra stores and extra staff) stays fully writable,
 * because a demo where nothing works is worse than no demo. The nightly reseed
 * restores all of it.
 */
export type DemoProtectedKind = "demo_store" | "demo_staff" | "demo_merchant_account";

const DEMO_READ_ONLY_MESSAGES: Record<DemoProtectedKind, string> = {
  demo_store: "متجر النسخة التجريبية محمي من التعديل — أنشئ متجراً جديداً لتجربة هذا الإجراء.",
  demo_staff: "حساب الموظف التجريبي محمي — أضف موظفاً جديداً لتجربة الأدوار والصلاحيات.",
  demo_merchant_account:
    "حساب التاجر التجريبي محمي — لا يمكن تغيير بريده أو كلمة مروره في النسخة التجريبية.",
};

/**
 * The identity that marks a row as seeded, per kind: the store slug, the staff
 * email, the merchant email. `identity` is whatever the call site already holds,
 * so no guard adds a database round-trip.
 */
const DEMO_PROTECTED_IDENTITIES: Record<DemoProtectedKind, string> = {
  demo_store: DEMO_STORE_SLUG,
  demo_staff: DEMO_STAFF_EMAIL,
  demo_merchant_account: DEMO_MERCHANT_EMAIL,
};

/**
 * Refuses a mutation that targets a seeded demo row while the demo flag is on.
 * Returns immediately — byte-for-byte today's behaviour — when the flag is off or
 * when the target is something the visitor created themselves.
 */
export function assertDemoWritable(
  kind: DemoProtectedKind,
  identity: string | null | undefined
): void {
  if (!config.demoMode) return;
  if (typeof identity !== "string") return;
  if (identity.trim().toLowerCase() !== DEMO_PROTECTED_IDENTITIES[kind]) return;
  throw new HttpError(403, "DEMO_READ_ONLY", DEMO_READ_ONLY_MESSAGES[kind]);
}
