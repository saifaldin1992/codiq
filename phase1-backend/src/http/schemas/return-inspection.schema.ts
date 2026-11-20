/**
 * RI-1 — resolving one returned reservation. The split arithmetic
 * (restock + writeOff === reservation.quantity) is checked in the service
 * against the live row, and again by the DB constraint; the schema asserts
 * shape and bounds only.
 */
import { z } from "zod";

export const resolveReturnInspectionSchema = z.object({
  restockQty: z.number().int().min(0).max(2_000_000_000),
  writeOffQty: z.number().int().min(0).max(2_000_000_000),
  note: z.string().max(500).optional(),
});
