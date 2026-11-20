/**
 * Phase 19-ج — the public merchant sign-up (phase 17, ADR-006).
 *
 * This is the form a STRANGER fills, the one endpoint on the platform anybody
 * may POST to, so the schema is written for the failure a stranger actually
 * meets: an empty box. And an empty box arrives as `""`, not as a missing key —
 * which is why this schema asserts the seven fields are STRINGS and leaves every
 * format rule where its Arabic sentence already lives.
 *
 * DELIBERATELY LOOSE, the platform-staff.schema.ts idiom. Each of the seven owns
 * a named refusal that says something specific and readable, and the landing
 * page shows `error.message` verbatim:
 *   businessName → INVALID_BUSINESS_NAME  «اسم النشاط يجب أن يتكون من حرفين على الأقل.»
 *   storeName    → INVALID_STORE_NAME     «اسم المتجر يجب أن يتكون من حرفين إلى 120 حرفاً.»
 *   storeSlug    → INVALID_STORE_SLUG     «يجب أن يكون رابط المتجر بأحرف إنجليزية صغيرة…»
 *   ownerName    → INVALID_OWNER_NAME, phone → INVALID_MERCHANT_PHONE,
 *   email        → INVALID_EMAIL, password → the password policy's own refusal.
 * Replacing any of those with a generic VALIDATION_FAILED would take a
 * translatable code away from the surface that needs it most and hand back a
 * server-rendered sentence — backwards for phase 22, which is half the reason
 * 19-ج exists.
 *
 * What the schema DOES buy: the seven keys are declared in one place with their
 * types, so the service's `typeof … !== "string"` branches are unreachable from
 * HTTP, and a body of the wrong shape entirely is refused before it can reach
 * `assertPhoneIsFree` and cost a query.
 */
import { z } from "zod";

export const registerMerchantSchema = z.object({
  businessName: z.string(),
  storeName: z.string(),
  storeSlug: z.string(),
  ownerName: z.string(),
  phone: z.string(),
  email: z.string(),
  password: z.string(),
});
export type RegisterMerchantInput = z.infer<typeof registerMerchantSchema>;
