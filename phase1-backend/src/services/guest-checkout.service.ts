/**
 * ق-201 — buying without an account.
 *
 * ============================================================================
 * THE SHAPE, AND WHY
 * ============================================================================
 *
 * A guest is a CUSTOMER ROW WITHOUT A PASSWORD, keyed on his phone at this
 * store. Not an order without a customer: everything around checkout — the
 * idempotency key, the cart, the saved address, the coupon lock, the order
 * history, the merchant's directory — is keyed on a customer id, and the
 * checkout transaction is the most tested path on the platform. A shadow row
 * reuses all of it UNCHANGED. The second guest order from the same phone lands
 * on the same row, the merchant sees one person, and when the shopper later
 * chooses a password the row becomes his account with every order in it.
 *
 * ============================================================================
 * THREE RULES
 * ============================================================================
 *
 *  1. A phone that belongs to an ACCOUNT is refused as a guest. Attaching a
 *     stranger's order to somebody's account is the one thing this must never
 *     do — and the message tells him to sign in, which is what he wants anyway.
 *  2. A guest spends no points. He has none, and the route drops the key.
 *  3. A replay is recognised BEFORE the cart merge. The merge bumps the cart
 *     version the checkout fingerprint was computed with, so the second tap on
 *     «تأكيد الطلب» would otherwise read as a different request under the same
 *     key (409) instead of the same order (200).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { normalizeOptionalEmail, normalizePhone } from "../auth/identity.js";
import {
  checkout,
  mergeGuestCartIntoCustomer,
  priorSucceededCheckout,
} from "./storefront.service.js";
import { guestCheckoutAllowed } from "./storefront-config.service.js";

export interface GuestIdentityInput {
  fullName?: unknown;
  phone?: unknown;
  email?: unknown;
}

const GUEST_SELECT = {
  id: true,
  storeId: true,
  fullName: true,
  email: true,
  phoneNormalized: true,
  isGuest: true,
} as const;
export type GuestCustomer = Prisma.CustomerGetPayload<{ select: typeof GUEST_SELECT }>;

/**
 * The shadow row for this phone at this store: reused when it is a guest's,
 * refused when it is an account's — and `created` says which of the two the
 * caller may hand an identity to.
 *
 * ق-232 — A PHONE NUMBER IS NOT PROOF OF A PHONE NUMBER.
 *
 * ق-201 matched the row on the phone alone, and the route then minted a
 * customer session for it and echoed the row back. So anyone who knew a
 * shopper's mobile number — the courier who delivered to him, the neighbour, the
 * merchant's ex-employee — could type it into «الشراء كضيض» at that store and
 * receive a live session AS that shopper: his email in the response, and every
 * past order with its address and phone from `/account/orders`. Two audits found
 * it independently; the code confirmed it.
 *
 * The order still lands on the matched row, because that is what the phone IS
 * proof of: whoever the courier calls at this number is who receives the parcel,
 * and the merchant is right to see one customer rather than two. What the phone
 * is NOT proof of is the right to read that row's history — so a session, and
 * the row's stored email, are issued only for a row THIS request brought into
 * existence, where there is nothing to read yet. The returning guest places his
 * order like anyone else; to open an account on that history he goes through a
 * door that proves something: the password he set from his own first order
 * (`setGuestPassword`), or password recovery by the email the row already holds.
 */
export async function guestCustomerFor(
  storeId: string,
  input: GuestIdentityInput
): Promise<{ customer: GuestCustomer; created: boolean }> {
  if (!(await guestCheckoutAllowed(storeId)))
    throw new HttpError(
      422,
      "GUEST_CHECKOUT_DISABLED",
      "هذا المتجر يطلب تسجيل الدخول لإتمام الطلب."
    );
  if (typeof input.fullName !== "string" || input.fullName.trim().length < 2)
    throw new HttpError(422, "INVALID_FULL_NAME", "اكتب اسمك الكامل.");
  const fullName = input.fullName.trim().slice(0, 120);
  const phoneNormalized = normalizePhone(input.phone);
  const phone = typeof input.phone === "string" ? input.phone.trim() : null;
  const email = normalizeOptionalEmail(input.email);

  const existing = await prisma.customer.findFirst({
    where: { storeId, phoneNormalized },
    select: { id: true, isGuest: true, isActive: true, passwordHash: true },
  });
  // A row with a password is an account whatever its flag says: password
  // recovery (PR-1) writes the hash and, by its own rule, nothing else.
  if (existing && (!existing.isGuest || existing.passwordHash))
    throw new HttpError(
      409,
      "CUSTOMER_ACCOUNT_EXISTS",
      "هذا الرقم مسجّل لدينا — سجّل الدخول لإتمام الطلب."
    );
  if (existing && !existing.isActive)
    throw new HttpError(403, "CUSTOMER_DISABLED", "تعذر إتمام الطلب بهذا الرقم — تواصل مع المتجر.");
  try {
    if (existing) {
      // The row the courier already knows: the name typed today is the name he
      // reads. The email is NOT overwritten here any more — a stranger must not
      // be able to re-point a shopper's recovery address by typing his number.
      return {
        customer: await prisma.customer.update({
          where: { id: existing.id },
          data: { fullName, phone },
          select: GUEST_SELECT,
        }),
        created: false,
      };
    }
    return {
      customer: await prisma.customer.create({
        data: {
          storeId,
          fullName,
          phone,
          phoneNormalized,
          email,
          passwordHash: null,
          isGuest: true,
        },
        select: GUEST_SELECT,
      }),
      created: true,
    };
  } catch (error) {
    // `customers_store_email_present_uq`: the email he typed is somebody's account here.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new HttpError(
        409,
        "EMAIL_TAKEN",
        "هذا البريد مستخدم لحساب آخر في هذا المتجر — اتركه فارغاً أو سجّل الدخول."
      );
    }
    throw error;
  }
}

export interface GuestCheckoutInput {
  idempotencyKey?: unknown;
  cartVersion?: unknown;
  address?: unknown;
  paymentMethodCode?: unknown;
  couponCode?: unknown;
  note?: unknown;
}

/**
 * Merge the guest's cart into his shadow row, then check out as that row.
 * `cartVersion` is the MERGED cart's: the version the client sent guarded a
 * cart the merge has just consumed, atomically, so the guard has been kept.
 */
export async function guestCheckout(
  storeId: string,
  customer: GuestCustomer,
  guestToken: string | undefined,
  input: GuestCheckoutInput
) {
  const prior = await priorSucceededCheckout(storeId, customer.id, input.idempotencyKey);
  if (prior) return { replayed: true as const, order: prior };
  const cart = await mergeGuestCartIntoCustomer(storeId, customer.id, guestToken);
  if (cart.id === null || cart.items.length === 0)
    throw new HttpError(422, "CART_EMPTY", "سلتك فارغة.");
  return checkout(storeId, customer.id, {
    idempotencyKey: input.idempotencyKey,
    cartVersion: cart.version,
    address: input.address,
    paymentMethodCode: input.paymentMethodCode,
    couponCode: input.couponCode,
    note: input.note,
    loyaltyPoints: undefined,
  });
}
