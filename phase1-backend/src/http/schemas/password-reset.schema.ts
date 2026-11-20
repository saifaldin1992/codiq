/**
 * PR-1 (19-أ) — «استعادة كلمة السر», shape at the edge.
 *
 * The password FLOOR is not restated here, exactly as `password.schema.ts`
 * refuses to restate it: it lives in `createPasswordHash` and nowhere else, and
 * a copy here would be a second definition of the platform's policy that parts
 * ways with the first the day one of them is raised. These schemas assert only
 * that something of the right shape arrived.
 *
 * `kind` is a closed enum rather than a free string so a caller cannot ask this
 * door about an identity kind that does not exist — and `customer` is absent on
 * purpose: a storefront customer is keyed PER STORE, so his request has its own
 * store-scoped route where the slug comes from the path, not from the body.
 */
import { z } from "zod";

export const requestPasswordResetSchema = z.object({
  kind: z.enum(["platform_owner", "platform_staff", "merchant", "staff"]),
  email: z.string().min(1),
});

/** The storefront twin: the store comes from the path, so only the address is sent. */
export const requestCustomerPasswordResetSchema = z.object({
  email: z.string().min(1),
});

/**
 * The token travels in a BODY, never in a path segment. A secret in a URL is
 * written to every access log, proxy log and `Referer` header between the
 * browser and the database — which is why `/unsubscribe/:token` is tolerable
 * (it grants only the right to stop mail) and this would not be (it grants the
 * account).
 */
export const inspectPasswordResetSchema = z.object({
  token: z.string().min(1),
});

export const consumePasswordResetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(1),
});
