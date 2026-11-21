/** zod shapes for platform coupons and points. */
import { z } from "zod";

export const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{3,20}$/, "٣–٢٠ حرفاً إنكليزيّاً كبيراً أو رقماً"),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable().optional(),
    kind: z.enum(["percent", "fixed"]),
    percentOff: z.number().int().min(1).max(90).nullable().optional(),
    amountOffIqd: z.number().int().positive().max(10_000_000).nullable().optional(),
    maxDiscountIqd: z.number().int().positive().max(10_000_000).nullable().optional(),
    minSubtotalIqd: z.number().int().min(0).max(100_000_000).default(0),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    totalLimit: z.number().int().positive().max(10_000_000).nullable().optional(),
    pointsCost: z.number().int().min(0).max(10_000_000).default(0),
    allStores: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: "النهاية بعد البداية",
    path: ["endsAt"],
  })
  .refine(
    (value) => (value.kind === "percent" ? Boolean(value.percentOff) : Boolean(value.amountOffIqd)),
    { message: "حدّد قيمة الخصم", path: ["percentOff"] }
  );

export const couponStoresSchema = z.object({
  storeSlugs: z
    .array(z.string().trim().min(1).max(120))
    .max(500)
    .transform((slugs) => Array.from(new Set(slugs))),
});
export const redeemSchema = z.object({ couponId: z.string().uuid() });
