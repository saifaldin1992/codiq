/**
 * Phase 19-ج — schemas for the SHOPPER-facing surface: the cart, the storefront
 * account, saved addresses, and checkout.
 *
 * THIS FILE IS DELIBERATELY THE LOOSEST IN THE LAYER, and the reason is the
 * surface, not laziness. These routes are unauthenticated or
 * customer-authenticated, rate-limited, and reachable from custom merchant
 * domains, so a schema that refuses an input the old code accepted does not
 * produce a tidier error — it stops a real person mid-checkout, on someone
 * else's domain, on a storefront client nobody here wrote. Every field below is
 * therefore modelled at exactly the width the service already accepted.
 *
 * WHAT THAT MEANS IN PRACTICE — three rules held throughout:
 *
 *  1. NAMED REFUSALS STAY WHERE THEY ARE. `INVALID_PRODUCT`,
 *     `INVALID_CART_QUANTITY`, `INVALID_CART_VERSION`, `INVALID_IDEMPOTENCY_KEY`,
 *     `INVALID_ADDRESS`, `INVALID_ORDER_NOTE`, `INVALID_COUPON_CODE`,
 *     `PAYMENT_METHOD_NOT_SUPPORTED`, `INVALID_PHONE`, `INVALID_EMAIL`,
 *     `INVALID_FULL_NAME` — each already carries a stable code, several are
 *     asserted by name (phase 9A and MD-1 both pin `INVALID_ORDER_NOTE`), and two
 *     of them answer 400, a status `parseOrThrow` cannot produce at all.
 *
 *  2. THE SILENT DEFAULTS ARE NOT TIGHTENED. `quantity` is read as
 *     `Number(value ?? 1)`, so a cart write with no quantity has always meant
 *     one unit; `isDefault` is read as `=== true`, so a raw HTML form posting
 *     the string "on" has always meant «not the default» rather than an error;
 *     `loyaltyPoints` that is not a positive integer has always meant zero
 *     points, silently. Each of those is a contract with clients this repository
 *     does not own. They are reported, not changed.
 *
 *  3. ⚠ `address` PASSES THROUGH UNTOUCHED, and this one is load bearing.
 *     `checkoutFingerprint` hashes `input.address ?? null` — the object EXACTLY
 *     as it arrived. Declaring its inner fields here would let zod strip an
 *     unrecognised key, which changes the hash, which makes a legitimate retry
 *     of an in-flight order answer `409 IDEMPOTENCY_KEY_REUSED` instead of
 *     replaying it. That is a duplicate-order bug reached by a shopper pressing
 *     «تأكيد الطلب» twice on a slow connection. `z.unknown()` is the only safe
 *     shape until 25أ redesigns the fingerprint on purpose.
 *
 * WHAT THE SCHEMAS DO BUY. Every shopper-facing body now arrives through a
 * declared, typed, CLOSED key set — including the checkout payload, which is the
 * exact object 25أ has to add payment fields to, and which until now was a raw
 * `request.body` spread. That is the prerequisite; tightening the widths is the
 * work 25أ and 22 will do with the payment and translation contracts in hand.
 */
import { z } from "zod";

/**
 * `addCartItem` accepts EITHER a variantId or a bare productId (a pre-20A
 * storefront still sends the second), and answers `400 INVALID_PRODUCT` when
 * neither is a string. `quantity` is optional because absent has always meant
 * one, and out-of-range answers `422 INVALID_CART_QUANTITY` with its own cap in
 * the message.
 */
export const addCartItemSchema = z.object({
  productId: z.unknown(),
  variantId: z.unknown(),
  quantity: z.unknown(),
});

/** The line-quantity PATCH carries one recognised key and nothing else. */
export const updateCartItemSchema = z.object({
  quantity: z.unknown(),
});

/**
 * Registration. `email` is genuinely optional (`normalizeOptionalEmail`), the
 * other three are required by the service and refused by name; the password is
 * judged by `assertPasswordAcceptable`, which is the ONE place a password
 * becomes a hash and must stay the only place it is judged.
 */
export const registerCustomerSchema = z.object({
  fullName: z.unknown(),
  phone: z.unknown(),
  password: z.unknown(),
  email: z.unknown(),
});

/**
 * Login. `password` stays `unknown` on purpose: `verifyPassword` already handles
 * a non-string by returning false, so every wrong credential — wrong type
 * included — leaves by the same `401 INVALID_CUSTOMER_CREDENTIALS` door. A type
 * assertion here would answer 422 for one class of wrong password and 401 for
 * the rest, which is a distinction an attacker can measure.
 */
export const loginCustomerSchema = z.object({
  phone: z.unknown(),
  password: z.unknown(),
});

/** A saved address. `requiredText` owns all four texts (400 INVALID_ADDRESS) and `normalizePhone` owns the contact (400 INVALID_PHONE). */
export const createAddressSchema = z.object({
  recipientName: z.unknown(),
  fullAddress: z.unknown(),
  city: z.unknown(),
  governorate: z.unknown(),
  phoneContact: z.unknown(),
  isDefault: z.unknown(),
});

/** The same keys, where absent means «leave this field alone» — a distinction `updateAddress` reads, so absent must stay absent after parsing. */
export const updateAddressSchema = createAddressSchema;

/**
 * Checkout — the payload 25أ extends.
 *
 * `idempotencyKey` is NOT a key here even though the storefront client puts one
 * in the body (`storefront-api.ts:165`): the `Idempotency-Key` HEADER has always
 * been the authority, the route overwrote the body's copy with it, and keeping
 * it out of the schema makes that unambiguous instead of merely true.
 */
export const checkoutSchema = z.object({
  cartVersion: z.unknown(),
  addressId: z.unknown(),
  address: z.unknown(),
  paymentMethodCode: z.unknown(),
  couponCode: z.unknown(),
  note: z.unknown(),
  loyaltyPoints: z.unknown(),
});

/**
 * ق-201 — checkout without an account: the same payload plus who is buying.
 * `loyaltyPoints` is deliberately NOT here — a guest has no balance to spend,
 * and the route drops the key if a client sends it anyway.
 */
export const guestCheckoutSchema = z.object({
  cartVersion: z.unknown(),
  address: z.unknown(),
  paymentMethodCode: z.unknown(),
  couponCode: z.unknown(),
  note: z.unknown(),
  fullName: z.unknown(),
  phone: z.unknown(),
  email: z.unknown(),
});

/** ق-201 — the one field that turns a guest into an account. */
export const setGuestPasswordSchema = z.object({
  password: z.unknown(),
});
