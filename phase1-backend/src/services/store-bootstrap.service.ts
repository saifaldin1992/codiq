import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { GOVERNORATE_KEYS } from "./governorates.js";
import { assertStoreSlugNotReserved } from "./reserved-slugs.js";

// ق-162: the list lives in ONE place now, beside the Arabic name a shopper
// reads. It used to be a private array here and a private label map in
// `DeliveryRatesManager.tsx`, and nothing made the two agree — which is how a
// shopper came to be asked, in Arabic, for a value only stored in English.

/** Creates only locked-ready settings for a new store; no external provider is activated. */
export async function createStoreFoundation(
  input: { merchantId: string; name: string; slug: string; defaultSubdomain: string },
  client: typeof prisma | Prisma.TransactionClient = prisma,
) {
  const slug = input.slug.trim().toLowerCase();
  const defaultSubdomain = input.defaultSubdomain.trim().toLowerCase();
  if (!slug || !defaultSubdomain) {
    throw new HttpError(400, "INVALID_STORE_IDENTIFIER", "Store slug and subdomain are required.");
  }
  // 19-د: this function is the ONE place a slug and a subdomain are written, so
  // it is where the reserved-label rule is unavoidable rather than remembered.
  // Both columns are checked: `default_subdomain` is what `storeForHost` matches
  // a hostname against, and nothing forces the two to stay equal forever.
  assertStoreSlugNotReserved(slug);
  assertStoreSlugNotReserved(defaultSubdomain);
  return client.store.create({
    data: {
      merchantId: input.merchantId,
      name: input.name.trim(),
      slug,
      defaultSubdomain,
      customDomain: null,
      paymentMethods: { create: [
        // ق-209: lowercase, the code every order carries; the card row that could
        // never be switched on is gone — a gateway arrives with 25أ, not as a dead row.
        { code: "cod", displayName: "الدفع عند الاستلام", isEnabled: true },
      ] },
      notificationSettings: { create: { provider: null, apiKey: null, senderId: null, isEnabled: false } },
      deliveryRates: { create: GOVERNORATE_KEYS.map((governorate) => ({ governorate, amountIqd: 0, isEnabled: false })) },
    },
  });
}

export async function notificationEligibility(storeId: string) {
  const settings = await prisma.notificationSettings.findUnique({ where: { storeId } });
  // 19-د (D-40): the column now holds an AEAD envelope, and «is a key set» is
  // still answered by its presence — this deliberately does NOT decrypt, because
  // knowing a credential exists never requires reading it. The one place it is
  // read back in the clear is `notificationApiKey()`.
  if (!settings || !settings.apiKey || !settings.isEnabled) return { allowed: false, reason: "NOT_CONFIGURED" as const };
  return { allowed: true, reason: "CONFIGURED" as const };
}
