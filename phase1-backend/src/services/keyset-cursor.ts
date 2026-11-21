/**
 * 19-د (ATTACK-SURFACE) — where a `cursor` from a query string used to be turned
 * into something safe to hand Prisma.
 *
 * TWO DEFECTS, ONE SHAPE. Several list endpoints took `request.query.cursor`
 * with a bare `typeof === "string"` check and passed it straight into
 * `cursor: { id }`:
 *
 *   1. A NON-UUID VALUE IS A 500. Every id column here is `@db.Uuid`, so
 *      `?cursor=abc` raised Prisma P2023 «Inconsistent column data: Error
 *      creating UUID», which `http/errors.ts` matched nothing for — it fell
 *      through to the bare `console.error` and a 500 INTERNAL_ERROR. Any signed-
 *      in merchant, staff member or storefront customer could produce an
 *      unhandled server error with one query parameter, and the storefront one
 *      needed nothing but an ordinary shopper account.
 *
 *   2. PRISMA RESOLVES THE CURSOR ROW BY ID ALONE. The emitted SQL was
 *      `... WHERE store_id = $1 AND (created_at = (SELECT created_at FROM t
 *      WHERE id = $2) ...)` — no `store_id` inside that subselect. The outer
 *      `where` still carried the tenant, so nothing foreign was RETURNED; what
 *      leaked was an existence-and-ordering oracle over another store's row.
 *
 * المرحلة 20-2 CLOSED BOTH BY REMOVING WHAT THEY GUARDED. Every list now pages
 * on a KEYSET predicate built from the cursor's own values
 * (`services/list-page.ts`), so Prisma is never given a `cursor` to resolve and
 * there is no anchor subselect to scope. The two validators that stood in front
 * of that anchor read — `keysetCursor` and `scopedKeysetCursor` — had no callers
 * left and were deleted rather than kept as a pattern someone would copy.
 *
 * `UUID_PATTERN` stays: it is the shared definition `list-page.ts` uses to
 * refuse a forged cursor id before it reaches a `@db.Uuid` column, and the
 * storefront uses for its category filter.
 */

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
