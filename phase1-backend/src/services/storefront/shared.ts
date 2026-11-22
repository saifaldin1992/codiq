/**
 * Storefront — shared. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import crypto from "node:crypto";
import { HttpError } from "../../auth/auth.errors.js";

const GUEST_CART_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_CART_QUANTITY = 99;

export const CART_STATUS_ACTIVE = "active";

export type CartContext = { customerId?: string; guestToken?: string };

export type CheckoutInput = {
  idempotencyKey?: unknown;
  cartVersion?: unknown;
  addressId?: unknown;
  address?: unknown;
  paymentMethodCode?: unknown;
  couponCode?: unknown;
  note?: unknown;
  loyaltyPoints?: unknown;
  fulfilment?: unknown;
  platformCouponWalletId?: unknown;
  /** Marketplace M13a: set by the market's checkout only. */
  marketPayment?: "card" | "instalments" | "partner";
};

export function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomGuestToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function nowPlusGuestLifetime() {
  return new Date(Date.now() + GUEST_CART_LIFETIME_MS);
}

export function requiredText(value: unknown, field: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new HttpError(400, "INVALID_ADDRESS", `${field} is invalid.`);
  return value.trim();
}

export function quantity(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CART_QUANTITY)
    throw new HttpError(
      422,
      "INVALID_CART_QUANTITY",
      `quantity must be an integer between 1 and ${MAX_CART_QUANTITY}.`
    );
  return parsed;
}

export function expectedCartVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new HttpError(400, "INVALID_CART_VERSION", "cartVersion must be a positive integer.");
  return parsed;
}

export function idempotencyKey(value: unknown) {
  if (typeof value !== "string" || value.length < 16 || value.length > 200)
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 16 to 200 characters."
    );
  return value;
}

export function isAvailable(stockQuantity: number, reservedQuantity: number | undefined) {
  return stockQuantity - (reservedQuantity ?? 0) > 0;
}
