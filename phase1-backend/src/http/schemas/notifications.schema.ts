/**
 * Phase 19-ج — the merchant's notification settings (phase 15, CD-1b, MD-3, WA-1).
 *
 * This body grew a block per phase, and with it a hand-written `INVALID_INPUT`
 * per key: «isEnabled must be boolean», «Unknown preference: x», «Unknown
 * dailyDigest key: y», «hour must be an integer between 0 and 23». Twelve
 * refusals, one code, none of them naming the field in a way a form could read —
 * the exact shape 19-ج exists to replace.
 *
 * THE CLOSED KEY SETS ARE THE POINT. `preferences`, `courierDispatch` and
 * `dailyDigest` are STRICT objects: an unknown key is a typo the merchant should
 * hear about, not a preference silently dropped on the floor. That was already
 * the behaviour (phase 15 asserts it); saying it in one word is what changed.
 *
 * WHAT STAYS IN THE SERVICE. `whatsappTemplates` is passed through untouched:
 * its rules are a key allow-list, a length cap AND a `{{token}}` allow-list with
 * its own Arabic messages (`validateWhatsappTemplatesInput`), and those are
 * meaning, not shape. The merge — which key is an override, which is a revert —
 * needs the STORED configuration and stays where the database is.
 */
import { z } from "zod";

/** The three events phase 15 can notify about; `normalizePreferences` owns the defaults. */
export const notificationPreferencesSchema = z.strictObject({
  orderCreated: z.boolean().optional(),
  orderStatusChanged: z.boolean().optional(),
  lowStock: z.boolean().optional(),
});

/**
 * CD-1b — a TOP-LEVEL block, never a fourth key inside `preferences` (phase 15
 * and CD-1 pin that trio by deepEqual). `enabled` is optional here because an
 * empty `{}` was accepted before and merges to «change nothing»; refusing it now
 * would break a client that sends the block unconditionally.
 */
export const courierDispatchSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
});

/**
 * MD-3 — the digest toggle and the hour it runs. The 0..23 window mirrors
 * `notification_settings_digest_hour_ck`; the database is still the
 * authority, and this exists so the merchant reads a sentence instead of a
 * constraint violation.
 */
export const dailyDigestSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
});

export const notificationSettingsUpdateSchema = z.object({
  isEnabled: z.boolean().optional(),
  preferences: notificationPreferencesSchema.optional(),
  courierDispatch: courierDispatchSettingsSchema.optional(),
  dailyDigest: dailyDigestSettingsSchema.optional(),
  // Shape asserted downstream, deliberately: see the header.
  whatsappTemplates: z.unknown(),
});

export type NotificationSettingsUpdate = z.infer<typeof notificationSettingsUpdateSchema>;
