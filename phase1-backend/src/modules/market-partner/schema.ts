/** zod shapes for the partner app. The signed bodies from the partner are checked by their signature first. */
import { z } from "zod";

export const partnerEnterSchema = z.object({ token: z.string().trim().min(20).max(4096) });
export const partnerLinkSchema = z.object({
  addressId: z.string().uuid(),
  fulfilment: z.enum(["delivery", "pickup"]).default("delivery"),
});
