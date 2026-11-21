/** zod shapes for support tickets. */
import { z } from "zod";
import { TICKET_TYPES } from "./tickets.service.js";

const types = TICKET_TYPES.map((entry) => entry.code) as unknown as [string, ...string[]];

export const openTicketSchema = z.object({
  orderId: z.string().uuid(),
  type: z.enum(
    types as [(typeof TICKET_TYPES)[number]["code"], ...(typeof TICKET_TYPES)[number]["code"][]]
  ),
  subject: z.string().trim().max(120).optional(),
  description: z.string().trim().min(10, "اشرح المشكلة في ١٠ أحرف على الأقلّ").max(3000),
});
export const replySchema = z.object({ body: z.string().trim().min(1, "اكتب ردّك").max(3000) });
export const supportReplySchema = replySchema.extend({ resolve: z.boolean().optional() });
export const confirmSchema = z.object({ resolved: z.boolean() });
export const statusSchema = z.object({ status: z.enum(["in_progress", "resolved"]) });
export const supportListQuerySchema = z.object({
  status: z
    .enum(["active", "open", "in_progress", "awaiting_customer", "resolved", "closed"])
    .optional(),
  escalated: z
    .enum(["1"])
    .optional()
    .transform((value) => value === "1"),
  cursor: z.string().max(512).optional(),
  limit: z.unknown().optional(),
});
