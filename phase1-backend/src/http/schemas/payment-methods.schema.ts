/** ق-209 — one switch and, for a wallet transfer, what the shopper must know. */
import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).nullish();

export const updatePaymentMethodSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    walletNumber: text(40),
    holderName: text(120),
    instructions: text(500),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "لا يوجد تغيير لتطبيقه." });
