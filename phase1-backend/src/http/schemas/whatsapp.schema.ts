/**
 * WA-1 (ق-139) — recording a manual WhatsApp tap.
 *
 * The body carries the templateKey ONLY. The message body is deliberately not
 * accepted from the client: the server re-renders and stores what IT rendered,
 * or the audit is worthless. The enum here mirrors WHATSAPP_TEMPLATE_KEYS in
 * whatsapp-manual.service.ts — the service re-checks against that list, so the
 * two cannot part ways silently.
 */
import { z } from "zod";

export const recordWhatsappSendSchema = z.object({
  templateKey: z.enum(["orderCreated", "courierDispatched", "orderCompleted"]),
});
