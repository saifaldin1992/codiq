/** ق-202 — the visit beacon's one optional field: the product the page was. */
import { z } from "zod";

export const visitSchema = z.object({ productId: z.string().uuid().optional() });
