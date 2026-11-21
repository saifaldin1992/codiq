/** zod shapes for the prize wheel. */
import { z } from "zod";

export const wheelSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .max(60)
      .regex(/^[a-z0-9-]+$/, "حروف إنكليزيّة صغيرة وأرقام وشرطات"),
    title: z.string().trim().min(1).max(80),
    howToPlay: z.string().trim().max(2000).nullable().optional(),
    isOpen: z.boolean().default(false),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    dailyFreeSpins: z.number().int().min(0).max(10).default(1),
    iqdPerExtraSpin: z.number().int().positive().max(100_000_000).default(25000),
    maxExtraSpinsPerOrder: z.number().int().min(0).max(20).default(3),
    maxWinsPerShopper: z.number().int().min(1).max(100).default(3),
    claimDays: z.number().int().min(1).max(90).default(7),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: "النهاية بعد البداية",
    path: ["endsAt"],
  });

export const prizeSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    kind: z.enum(["nothing", "points", "coupon", "physical"]),
    weight: z.number().int().min(0).max(1_000_000),
    stock: z.number().int().min(0).max(10_000_000).nullable().optional(),
    points: z.number().int().positive().max(1_000_000).nullable().optional(),
    couponId: z.string().uuid().nullable().optional(),
    position: z.number().int().min(0).max(100).default(0),
    isActive: z.boolean().default(true),
  })
  .refine((value) => value.kind !== "points" || Boolean(value.points), {
    message: "حدّد عدد النقاط",
    path: ["points"],
  })
  .refine((value) => value.kind !== "coupon" || Boolean(value.couponId), {
    message: "اختر الكوبون",
    path: ["couponId"],
  })
  .refine((value) => value.kind !== "physical" || typeof value.stock === "number", {
    message: "الجائزة العينيّة تحتاج كمّيّة",
    path: ["stock"],
  });

export const claimSchema = z.object({ addressId: z.string().uuid().optional() });
export const winStatusSchema = z.object({
  status: z.enum(["delivered", "cancelled"]),
  note: z.string().trim().max(300).optional(),
});
export const queueQuerySchema = z.object({
  status: z.enum(["pending", "claimed", "shipping", "delivered", "cancelled"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.unknown().optional(),
});
export const supportQuerySchema = z.object({ phone: z.string().trim().min(8).max(20) });
