/** zod shapes for campaigns and hourly deals. */
import { z } from "zod";

const when = z.coerce.date();
export const campaignSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .max(60)
      .regex(/^[a-z0-9-]+$/, "حروف إنكليزيّة صغيرة وأرقام وشرطات"),
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(200).nullable().optional(),
    startsAt: when,
    endsAt: when,
    minPercent: z.number().int().min(1).max(90).default(10),
    isPublished: z.boolean().default(false),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: "النهاية بعد البداية",
    path: ["endsAt"],
  })
  .refine((value) => value.endsAt.valueOf() - value.startsAt.valueOf() <= 60 * 86_400_000, {
    message: "ستّون يوماً على الأكثر",
    path: ["endsAt"],
  });

export const campaignDaysSchema = z.object({
  days: z
    .array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        title: z.string().trim().min(1).max(80),
        note: z.string().trim().max(300).nullable().optional(),
      })
    )
    .max(60)
    .refine((days) => new Set(days.map((day) => day.day)).size === days.length, {
      message: "يوم مكرّر",
    }),
});

export const slotSchema = z
  .object({ title: z.string().trim().max(80).nullable().optional(), startsAt: when, endsAt: when })
  .refine((value) => value.endsAt > value.startsAt, {
    message: "النهاية بعد البداية",
    path: ["endsAt"],
  })
  .refine((value) => value.endsAt.valueOf() - value.startsAt.valueOf() <= 86_400_000, {
    message: "يوم واحد على الأكثر",
    path: ["endsAt"],
  });

export const dealDecisionSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(300).optional(),
});
export const proposeDealSchema = z.object({
  slotId: z.string().uuid(),
  productId: z.string().uuid(),
  percentOff: z.number().int().min(1).max(90),
});
export const dealsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.unknown().optional(),
});
