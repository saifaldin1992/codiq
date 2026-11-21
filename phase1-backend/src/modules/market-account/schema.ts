/** zod shapes for the market shopper's account. Phone numbers are normalized in the service, where the rule lives. */
import { z } from "zod";

const phone = z.string().trim().min(8).max(20);

export const requestCodeSchema = z.object({ phone });
export const verifyCodeSchema = z.object({
  challengeId: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "الرمز ستّة أرقام"),
});

export const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(80).nullable(),
  email: z.string().trim().max(254).email("البريد الإلكترونيّ غير صحيح").nullable(),
  gender: z.enum(["male", "female"]).nullable(),
  interests: z
    .array(z.number().int().positive())
    .max(30)
    .transform((ids) => Array.from(new Set(ids))),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const addressSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    recipientName: z.string().trim().min(2).max(80),
    phone,
    altPhone: phone.nullable(),
    governorateKey: z.string().trim().min(1).max(40),
    districtId: z.number().int().positive(),
    addressLine: z.string().trim().min(5).max(300),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    isDefault: z.boolean().optional(),
    // Required only when the phone is not the shopper's own (already proven at sign-in).
    phoneVerification: z
      .object({
        challengeId: z.string().uuid(),
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/),
      })
      .nullable()
      .optional(),
  })
  .refine((value) => (value.latitude === null) === (value.longitude === null), {
    message: "خطّ العرض وخطّ الطول معاً",
    path: ["latitude"],
  });
export type AddressInput = z.infer<typeof addressSchema>;

export const addressPhoneCodeSchema = z.object({ phone });
