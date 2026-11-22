/**
 * codiq phase 14 — server-side staff permission contract (D14-01..D14-07).
 * The resolver reads role + overrides from the database on every sensitive request;
 * no role, storeId, or membershipId coming from a request body is ever trusted.
 */
import { touchSession } from "../services/session.service.js";
import type { Request } from "express";
import { prisma } from "../db/prisma.js";
import { HttpError } from "./auth.errors.js";
import { readSessionClaims, verifyTypedSession, type SessionClaims } from "./identity.js";
import { identityBoundaryMessage } from "./redirects.js";
import { readWebSessionCookie } from "../http/session-cookie.js";

export const PERMISSION_CODES = [
  "catalog.products.view",
  "catalog.products.create",
  "catalog.products.update",
  "catalog.products.delete",
  "catalog.categories.manage",
  "inventory.update",
  "orders.view",
  "orders.update",
  "customers.view",
  // D-64 (ق-244): creating a customer by hand was gated by `customers.view` — a
  // READ permission on a WRITE route, the one least-privilege hole in the
  // D14-04 matrix. Its own code now; store_manager holds it by role (every code),
  // store_staff does not.
  "customers.manage",
  "team.manage",
  "settings.manage",
  // PG-2: the trash bin and the activity log. All three are store_manager-only
  // (see ROLE_PERMISSION_MATRIX): a store_staff member must not be able to read
  // the log that names whoever disabled him, nor to undo a manager's removal.
  "catalog.trash.view",
  "catalog.trash.restore",
  "catalog.audit.view",
  // ق-132: operating a till. Deliberately SEPARATE from orders.update — a
  // cashier sells at the counter without being able to edit delivery orders,
  // read reports, or see anyone else's takings.
  "pos.sell",
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const STAFF_ROLE_CODES = ["store_manager", "store_staff"] as const;
export type StaffRoleCode = (typeof STAFF_ROLE_CODES)[number];

/** Owner-approved D14-04 matrix. store_manager holds every code; store_staff holds the operational four. */
export const ROLE_PERMISSION_MATRIX: Record<StaffRoleCode, readonly PermissionCode[]> = {
  store_manager: PERMISSION_CODES,
  store_staff: ["catalog.products.view", "inventory.update", "orders.view", "orders.update", "pos.sell"],
};

export function assertPermissionCode(value: unknown): PermissionCode {
  if (typeof value !== "string" || !PERMISSION_CODES.includes(value as PermissionCode)) {
    throw new HttpError(422, "INVALID_PERMISSION_CODE", "صلاحية غير معروفة.");
  }
  return value as PermissionCode;
}

export function assertStaffRoleCode(value: unknown): StaffRoleCode {
  if (typeof value !== "string" || !STAFF_ROLE_CODES.includes(value as StaffRoleCode)) {
    throw new HttpError(422, "INVALID_STAFF_ROLE", "الأدوار المتاحة: مدير متجر أو موظف متجر.");
  }
  return value as StaffRoleCode;
}

/** Role matrix + per-membership overrides. One override per code: allow grants, deny removes. */
export function resolvePermissionSet(roleCode: string, overrides: readonly { permissionCode: string; effect: string }[]): Set<PermissionCode> {
  const base = ROLE_PERMISSION_MATRIX[roleCode as StaffRoleCode] ?? [];
  const granted = new Set<PermissionCode>(base);
  for (const override of overrides) {
    const code = override.permissionCode as PermissionCode;
    if (!PERMISSION_CODES.includes(code)) continue;
    if (override.effect === "allow") granted.add(code);
    else if (override.effect === "deny") granted.delete(code);
  }
  return granted;
}

export interface StoreStaffContext {
  claims: SessionClaims;
  store: { id: string; slug: string; merchantId: string };
  staff: { id: string; email: string; displayName: string };
  /** Audit 14-ب: true only when the caller opted in with `allowPasswordChangePending`. */
  mustChangePassword: boolean;
  membership: { id: string; roleCode: string; permissionVersion: number };
  permissions: Set<PermissionCode>;
}

export type StoreActor =
  | { kind: "merchant"; id: string }
  | { kind: "staff"; id: string; membershipId: string };

export interface StoreActorContext {
  store: { id: string; slug: string; merchantId: string };
  actor: StoreActor;
  /**
   * The FULL resolved permission set of the actor (the owning merchant holds
   * every code by construction). Endpoints that serve more than one permission
   * domain — the MD-1 unified search is the first — read this instead of relying
   * on the single code the guard was called with, so each domain in the response
   * can be gated by its own permission rather than by one proxy guard.
   */
  permissions: Set<PermissionCode>;
}

function bearerTokenFromRequest(request: Request): string {
  const header = request.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const sessionCookie = readWebSessionCookie(request);
  if (sessionCookie) return sessionCookie;
  throw new HttpError(401, "MISSING_SESSION", "سجّل الدخول لمتابعة هذه الخطوة.");
}

/**
 * ق-218 — a password somebody else chose opens nothing but the door that
 * replaces it.
 *
 * `createManualMerchant` lets a platform actor type the account's first
 * password. Nothing ever made it temporary: the merchant received it over
 * WhatsApp and had no reason to change a credential nobody told him was
 * provisional, so the person who typed it kept a working key to a live merchant
 * account — every shopper's name, phone and address, the order export, the COD
 * settlement details — with the store's own audit log attributing all of it to
 * the merchant. Platform staff hold no permission code that opens a merchant
 * dashboard, so this was the one path that granted it. And B-09 makes it the
 * LAUNCH path: the first ten merchants are recruited by hand.
 *
 * The refusal is 403 with a named code so the screen can say what to do, and
 * `POST /auth/password` is deliberately outside every guard that calls this: he
 * must always be able to reach the one action that clears it.
 *
 * It lives here rather than in `http/shared.ts` because this file is where the
 * guard that almost every store route uses already reads the merchant's live
 * state — the second argument is that same read, so the common path costs no
 * extra query.
 */
export async function assertMerchantOwnsHisPassword(merchantId: string, provisionedAt?: Date | null) {
  const flagged = provisionedAt !== undefined
    ? provisionedAt
    : (await prisma.merchant.findUnique({ where: { id: merchantId }, select: { passwordSetByProvisionerAt: true } }))?.passwordSetByProvisionerAt ?? null;
  if (flagged) {
    throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "كلمة المرور الحالية اختارها من أنشأ حسابك. غيّرها من «الأمان» لتتابع — بعدها لا يعرفها غيرك.");
  }
}

async function resolveStoreBySlug(storeSlug: string) {
  // ق-192: `merchant.isActive` is selected because the guards below must refuse
  // a disabled merchant. It was not, and that is the whole defect — see the
  // comment on the merchant branch of `resolveStoreActor`.
  // ق-218 rides the SAME select rather than a second query: the guard already
  // reads the merchant row's live state on every store request.
  const store = await prisma.store.findUnique({ where: { slug: storeSlug }, select: { id: true, slug: true, merchantId: true, isActive: true, merchant: { select: { isActive: true, passwordSetByProvisionerAt: true } } } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
  return store;
}

/**
 * D14-07 live gate: a valid staff session is not enough — the staff record and the exact
 * membership bound to the session must still be active on every request.
 */
/**
 * Audit 14-ب: `allowPasswordChangePending` is for the ONE caller that must still
 * answer while the employee holds a merchant-chosen password — the session probe,
 * so the dashboard can load and send him to «الأمان». Every other surface refuses.
 */
export async function requireStoreStaff(request: Request, options: { allowPasswordChangePending?: boolean } = {}): Promise<StoreStaffContext> {
  const claims = await verifyTypedSession(bearerTokenFromRequest(request), "staff");
  const store = await resolveStoreBySlug(request.params.storeSlug);
  if (store.id !== claims.storeId) {
    throw new HttpError(403, "STORE_BOUNDARY_DENIED", "هذا المتجر ليس ضمن عضوياتك.");
  }
  const membership = await prisma.storeStaffMembership.findFirst({
    // PG-2: a removed membership must not resolve permissions on ANY request.
    where: { id: claims.membershipId!, staffId: claims.subjectId, storeId: store.id, deletedAt: null },
    select: {
      id: true,
      roleCode: true,
      isActive: true,
      permissionVersion: true,
      staff: { select: { id: true, email: true, displayName: true, isActive: true, passwordSetByProvisionerAt: true } },
      permissionOverrides: { select: { permissionCode: true, effect: true } },
    },
  });
  if (!membership || !membership.isActive || !membership.staff.isActive) {
    throw new HttpError(401, "STAFF_ACCESS_REVOKED", "عضويتك في هذا المتجر موقوفة — تواصل مع صاحب المتجر.");
  }
  const mustChangePassword = Boolean(membership.staff.passwordSetByProvisionerAt);
  if (mustChangePassword && !options.allowPasswordChangePending) {
    throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "كلمة المرور الحالية اختارها التاجر عند إضافتك. غيّرها من «الأمان» لتتابع — بعدها لا يعرفها غيرك.");
  }
  // ق-192: a staff member works FOR a merchant, so a disabled merchant revokes
  // his people too. Without this, disabling a merchant left every one of his
  // staff writing to the store he was just stopped from touching — a wider hole
  // than the merchant's own, because a store may have many.
  //
  // `store.isActive` is deliberately NOT checked here. Deactivating a store is
  // how the platform hides a storefront, and the trial-expiry service argues at
  // length that locking the merchant out of the dashboard «where he would fix
  // it» is indefensible; whether that argument extends to his staff is a product
  // decision nobody has made. It is recorded as D-95 rather than decided here.
  if (!store.merchant.isActive) {
    throw new HttpError(403, "MERCHANT_DISABLED", "حساب التاجر موقوف — تواصل مع إدارة المنصة.");
  }
  // Phase 19: the employee's own «جلساتي» list shows the device and last use of
  // each session — and only the merchant's path ever stamped them, so an
  // employee's list showed every session as «unknown device, never used».
  touchSession(claims, request);
  return {
    claims,
    store,
    staff: { id: membership.staff.id, email: membership.staff.email, displayName: membership.staff.displayName },
    mustChangePassword,
    membership: { id: membership.id, roleCode: membership.roleCode, permissionVersion: membership.permissionVersion },
    permissions: resolvePermissionSet(membership.roleCode, membership.permissionOverrides),
  };
}

/**
 * Store authorization for endpoints shared by the owning merchant and permitted staff.
 * The merchant owner authorizes through store ownership exactly as before phase 14;
 * staff authorize through the live membership + resolver, never through client input.
 */
export async function requireStoreActor(request: Request, permission: PermissionCode): Promise<StoreActorContext> {
  return resolveStoreActor(request, [permission], "every");
}

/**
 * Same guard, but the actor only needs ONE of the listed permissions to pass.
 * The caller is then obliged to gate each part of its response on the matching
 * code through the returned `permissions` set — see the unified search route.
 */
export async function requireStoreActorAny(request: Request, permissions: readonly PermissionCode[]): Promise<StoreActorContext> {
  return resolveStoreActor(request, permissions, "some");
}

async function resolveStoreActor(request: Request, permissions: readonly PermissionCode[], mode: "every" | "some"): Promise<StoreActorContext> {
  const token = bearerTokenFromRequest(request);
  const kind = readSessionClaims(token).identityKind;
  if (kind === "merchant") {
    const claims = await verifyTypedSession(token, "merchant");
    // Phase 19: records that this session was used, and from what browser, so
    // its owner can recognise it in his own list. Fire-and-forget by design.
    touchSession(claims, request);
    const store = await resolveStoreBySlug(request.params.storeSlug);
    if (store.id !== claims.storeId || store.merchantId !== claims.subjectId) {
      throw new HttpError(403, "STORE_BOUNDARY_DENIED", "هذا المتجر ليس من متاجرك.");
    }
    // ق-192 — the platform disabled him and he kept working for up to eight hours.
    //
    // `decideMerchantApproval` sets `merchant.isActive = false` on a rejection or
    // a disable, and `requireMerchantStore` (http/shared.ts) has always refused a
    // disabled merchant with this exact error. THIS guard — the one almost every
    // store route actually uses — never asked. So the owner's decision to stop a
    // merchant took effect on his NEXT LOGIN rather than his next request, and a
    // merchant told he was rejected kept full write access to orders, catalogue,
    // customers and settings until his token expired.
    //
    // The two guards disagreeing was the defect. They agree now, in wording and
    // in status, because a route's choice of guard must never change who may act.
    if (!store.merchant.isActive) {
      throw new HttpError(403, "MERCHANT_DISABLED", "حساب التاجر موقوف — تواصل مع إدارة المنصة.");
    }
    // ق-218, and for the same reason ق-192 put `isActive` here: THIS is the guard
    // almost every store route actually uses, so a rule that lives only in
    // `requireMerchantStore` is a rule most of the platform never asks about.
    await assertMerchantOwnsHisPassword(claims.subjectId, store.merchant.passwordSetByProvisionerAt);
    return { store, actor: { kind: "merchant", id: claims.subjectId }, permissions: new Set(PERMISSION_CODES) };
  }
  if (kind === "staff") {
    const context = await requireStoreStaff(request);
    const satisfied = mode === "every" ? permissions.every((code) => context.permissions.has(code)) : permissions.some((code) => context.permissions.has(code));
    if (!satisfied) {
      const missing = permissions.filter((code) => !context.permissions.has(code)).join(", ");
      throw new HttpError(403, "STAFF_PERMISSION_DENIED", mode === "every"
        ? `This staff membership lacks the ${missing} permission.`
        : `This staff membership lacks every permission this endpoint can serve (${missing}).`);
    }
    return { store: context.store, actor: { kind: "staff", id: context.staff.id, membershipId: context.membership.id }, permissions: context.permissions };
  }
  // PS-3: a store surface takes the merchant himself or one of his staff.
  throw new HttpError(403, "IDENTITY_BOUNDARY_DENIED", identityBoundaryMessage(kind, "تاجر أو موظّف متجر"));
}
