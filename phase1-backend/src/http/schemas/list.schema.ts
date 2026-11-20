/**
 * المرحلة 20-2 — the pagination query parameters, as a schema.
 *
 * ONE AUTHORITY, NOT TWO. `limit` and `cursor` are checked here, at the edge,
 * with `parseOrThrow` like every other input — but the RULES are not restated
 * here. `parseListLimit` and the cursor decoder in `services/list-page.ts`
 * remain the single implementation, and this schema calls them. A zod copy of
 * «between 1 and 100» beside the service's own copy is exactly the drift 20-2
 * exists to remove: two implementations of one rule disagree the day one of
 * them is edited.
 *
 * A rule thrown from inside a zod transform propagates out of `safeParse`
 * unchanged, so a bad `limit` keeps its own stable `INVALID_LIMIT` code and its
 * own sentence rather than becoming a generic `VALIDATION_FAILED`. That is
 * deliberate: `limit` and `cursor` are the two query parameters a CLIENT
 * constructs, and a client needs to know which of them it got wrong.
 */
import { z } from "zod";
import { LIST_LIMIT_MAX, parseListLimit } from "../../services/list-page.js";

/**
 * `limit` — absent, empty, or an integer inside the shared window. Anything
 * else is `400 INVALID_LIMIT`, never a silent clamp.
 */
export const listLimitSchema = z.unknown().optional().transform((value) => parseListLimit(value));

/**
 * `cursor` — shape only. The cursor's MEANING (version, list kind, ordering
 * value, row id) is decoded by `decodeListCursor` inside the service that owns
 * the list, because only that service knows which list the cursor must belong
 * to. All this floor does is refuse a non-string and an absurd length before a
 * base64 decode and a `JSON.parse` are attempted on it.
 */
export const listCursorSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().max(512, "مؤشر الصفحة غير صالح — أعِد فتح القائمة من بدايتها.").optional(),
);

/** The two parameters every list route accepts, and nothing else. */
export const paginationQuerySchema = z.object({
  limit: listLimitSchema,
  cursor: listCursorSchema,
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** `limit` alone, for the ranked surfaces that answer in one page by design. */
export const listLimitQuerySchema = z.object({ limit: listLimitSchema });

export { LIST_LIMIT_MAX };
