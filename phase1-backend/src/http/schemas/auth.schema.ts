/**
 * Phase 19-ج — the five legacy doors in `routes/auth.ts` (ق-49, settles D-14).
 *
 * WHAT THESE ASSERT, AND NOTHING MORE: that a field arrived and that it is a
 * string. Every SEMANTIC refusal stays exactly where it was — `normalizeEmail`
 * still answers `INVALID_EMAIL`, `assertPasswordAcceptable` still answers
 * `WEAK_PASSWORD`, `normalizeIraqiMobile` still answers `INVALID_MERCHANT_PHONE`
 * and `loginMerchant` still answers `INVALID_MERCHANT_IDENTIFIER`. That is the
 * same line `password.schema.ts` drew in 19-أ, for the same reason: a copy of
 * the password policy (or of the Iraqi-mobile rule) in a schema is a SECOND
 * definition of it, and the two would part ways the first time one is raised.
 *
 * The practical consequence is that nothing a FORM can send behaves differently.
 * An empty email, a six-character password, a landline, «متجر» as a personal
 * name — all still travel to the service and come back with the code the client
 * and the tests already name. Only a value of the wrong TYPE (a number where a
 * string belongs) now answers `VALIDATION_FAILED` instead, and no browser form
 * can produce one.
 *
 * ⚠ The two fields left `unknown` are left so DELIBERATELY. `ownerName` and
 *   `phone` are REQUIRED by `registerMerchant`, and phase1 asserts that a
 *   missing one answers `INVALID_OWNER_NAME` / `INVALID_MERCHANT_PHONE` — codes
 *   a required `z.string()` here would swallow. Same for `identifier`, whose
 *   absence is a 400 `INVALID_MERCHANT_IDENTIFIER`, and for `totpCode`, where
 *   `null` and `""` must reach `SECOND_FACTOR_REQUIRED` rather than a 422.
 */
import { z } from "zod";

export const registerPlatformOwnerSchema = z.object({
  email: z.string(),
  password: z.string(),
  displayName: z.string(),
});

export const loginPlatformOwnerSchema = z.object({
  email: z.string(),
  password: z.string(),
  // Service-owned: the ABSENCE of a code is an answer here (`SECOND_FACTOR_REQUIRED`),
  // not a malformed request.
  totpCode: z.unknown().optional(),
});

export const registerMerchantSchema = z.object({
  email: z.string(),
  password: z.string(),
  businessName: z.string(),
  // Service-owned — see the note at the head of this file.
  ownerName: z.unknown().optional(),
  phone: z.unknown().optional(),
});

export const loginMerchantSchema = z.object({
  // P27-21: the identifier is an email OR an Iraqi mobile, and deciding which is
  // `loginMerchant`'s job — it answers a malformed one with a 400 that reveals
  // nothing about who exists.
  identifier: z.unknown().optional(),
  password: z.string(),
});

export const loginStaffSchema = z.object({
  email: z.string(),
  password: z.string(),
});
