/**
 * ق-132 schemas for the till.
 *
 * Shape only, as everywhere in this layer: whether the arithmetic is
 * consistent, whether the device is revoked, whether the variant belongs to
 * this store — those are the service's questions, because answering them takes
 * the database. The bounds here are the ones a schema CAN honestly hold: a
 * sale has between one and a hundred lines, quantities and prices are bounded
 * integers, and the ids are uuids.
 */
import { z } from "zod";

export const posDeviceSchema = z.object({
  label: z.string().trim().min(2).max(60),
});

export const posTicketSchema = z.object({
  deviceId: z.string().uuid(),
  ticketId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        quantity: z.number().int().min(1).max(10_000),
        unitPriceIqd: z.number().int().min(0).max(1_000_000_000),
      })
    )
    .min(1)
    .max(100),
  discountIqd: z.number().int().min(0),
  totalIqd: z.number().int().min(0),
  customerName: z.string().trim().max(120).optional(),
  deviceReportedAt: z.string(),
});
