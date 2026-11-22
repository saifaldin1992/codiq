/**
 * Market payments — events. Split verbatim from payments.service.ts (review batch 2, ت-٨);
 * payments.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";

export type Shopper = { id: string; phoneNormalized: string };

export async function event(
  paymentId: string,
  kind: string,
  extra: { providerEventId?: string; amountIqd?: number; detail?: Record<string, unknown> } = {}
) {
  await prisma.marketPaymentEvent.create({
    data: {
      paymentId,
      kind,
      providerEventId: extra.providerEventId ?? null,
      amountIqd: extra.amountIqd ?? null,
      detail: (extra.detail ?? {}) as object,
    },
  });
}
