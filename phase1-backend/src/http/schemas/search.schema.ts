/**
 * PG-6 (ق-74) — the first QUERY-PARAMETER schemas in the codebase.
 *
 * Query-param coverage was 0% before this file: every `q`, `limit` and `cursor`
 * in 215 routes is read straight off `request.query` and validated by hand, in
 * ten different ways — nine services silently clamp a bad `limit` and one
 * rejects it. This file is the template 20-2 and 20-4 build on, so its shape
 * matters more than its size.
 *
 * SHAPE HERE, MEANING IN THE SERVICE — the rule stated in `http/validate.ts`.
 * A schema can say «between two and a hundred and twenty characters». It cannot
 * say «this needle is phone-shaped and therefore may probe a customer's
 * number», because that is a POLICY the merchant-search service owns and the
 * customer directory must reuse verbatim.
 *
 * Applied with `parseOrThrow` inside the handler closure — the house's
 * imperative pattern (`pos.ts:41-46`, `return-inspection.ts:17-26`) — and NOT
 * with `validateQuery`, which is a dead export (`validate.ts:97`).
 *
 * ⚠ The three long-standing surfaces (the command palette, the storefront
 *   product filter, the trash bin) keep their OWN error codes —
 *   `INVALID_SEARCH_QUERY`, `INVALID_PRODUCT_FILTER` — because those codes are
 *   asserted by md1 and phase9A and are part of the contract 20-2 will unify
 *   deliberately, in one sweep, rather than by accident here.
 */
import { z } from "zod";

/** Below two characters a trigram index has no full trigram to stand on, and the query degrades to a scan. */
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 120;

/**
 * The needle. Trimmed first, so «  ا  » is one character and is refused rather
 * than sweeping the store.
 *
 * The message is the one the command palette already shows, word for word, and
 * in masculine address (ق-96): a shopper meeting the floor on the storefront and
 * a merchant meeting it in the palette must not be told two different things.
 */
export const searchNeedleSchema = z
  .string({ error: "أدخل حرفين على الأقل للبحث." })
  .trim()
  .min(SEARCH_MIN_QUERY_LENGTH, "أدخل حرفين على الأقل للبحث.")
  .max(SEARCH_MAX_QUERY_LENGTH, `الحد الأقصى لطول البحث ${SEARCH_MAX_QUERY_LENGTH} حرفاً.`);

/**
 * The same needle where searching is optional — an absent, empty or
 * whitespace-only `q` means «no search», not «a bad search». Express gives a
 * missing parameter as `undefined` and an empty one as `""`, and both must mean
 * the unfiltered list; a floor that refused `?q=` would break every list page
 * that merely renders an empty search box.
 */
export const optionalSearchNeedleSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  searchNeedleSchema.optional(),
);

/** `limit`, with the platform's long-standing 1..100 window and a default of 25. */
export const searchLimitSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : Number(value)),
  z.number({ error: "limit يجب أن يكون رقماً بين 1 و100." }).int("limit يجب أن يكون رقماً صحيحاً.").min(1, "limit يجب أن يكون 1 على الأقل.").max(100, "limit يجب ألا يتجاوز 100.").default(25),
);

/**
 * The till's online product search (`GET /merchant/stores/:slug/pos/products`).
 * A NEW route, so it is schema-validated from the start — the rule
 * `validation-adoption.guard.mjs` states for any new route file.
 */
export const posProductSearchQuerySchema = z.object({
  q: searchNeedleSchema,
  limit: searchLimitSchema,
});

export type PosProductSearchQuery = z.infer<typeof posProductSearchQuerySchema>;

/**
 * The merchant catalog's new `q` (`GET /merchant/stores/:slug/catalog/products`).
 * Only `q` is modelled: `limit`, `cursor` and `lowStock` are pre-existing inputs
 * with pre-existing clamping behaviour, and moving them into a schema would
 * change the answer a live client already depends on. 20-2 unifies them
 * everywhere at once, on purpose.
 */
export const catalogProductSearchQuerySchema = z.object({
  q: optionalSearchNeedleSchema,
});

/**
 * The `q` shared by the merchant order list, the platform order list and the
 * customer directory. Same shape, same floor, same message on all three — which
 * is the point: today the palette enforces two characters and the other three
 * enforce nothing.
 */
export const listSearchQuerySchema = z.object({
  q: optionalSearchNeedleSchema,
});
