/**
 * المرحلة 20-2 «العقد الموحّد» — the ONE list envelope and the ONE cursor
 * dialect (D-18, D-73, D-74).
 *
 * WHAT WAS HERE BEFORE. The [pagination] audit counted, across 215 routes:
 * 33 list routes with no pagination at all, 22 more capped at a fixed `take: N`
 * with no way to reach row N+1, 10 raw-id cursors, and exactly 3 encoded ones.
 * Three cursor dialects coexisted — an encoded `(createdAt,id)` keyset
 * (order-lifecycle), a Prisma `cursor:{id}` + `skip:1` anchor read (nine
 * services), and soft-delete's own `deletedAt|id` pipe-joined string — and the
 * page metadata came back under six structurally different shapes.
 *
 * THE ENVELOPE. Every list route answers with exactly:
 *
 *     { <resource>: T[], nextCursor: string | null, ...facets }
 *
 * The array key is the RESOURCE NAME (`products`, `orders`, `events`), not a
 * generic `items`: `items` is already a domain word here — an order's lines and
 * a cart's lines are both `items` — so `{ items }` on `GET /orders` would name
 * two different things one key. `nextCursor` is the single source of truth for
 * «is there a page 2»: `null` means this was the last page, and there is no
 * second, redundant `hasMore` beside it that could ever disagree with it.
 * `facets` are named, non-array siblings a route needs (`availableTags`,
 * `summary`, `storeSlug`) — never a second collection of the same resource.
 *
 * THE CURSOR. Opaque, always: `base64url(JSON)` carrying a version, the LIST
 * KIND, the ordering value and the row id. Opaque because a client that can
 * read a cursor starts building one, and the day the sort column changes every
 * hand-built cursor becomes a silently wrong page. The kind tag is what makes a
 * cursor from another list a clean 400 instead of an empty page or a 500.
 *
 * WHY NOT PRISMA'S `cursor` + `skip: 1`. Two defects, both diagnosed in
 * `services/keyset-cursor.ts`: a non-uuid raised an unmapped P2023 (a 500 any
 * signed-in caller could produce with one query parameter), and Prisma resolves
 * the anchor row BY ID ALONE — `WHERE id = $2` with no `store_id` in that
 * subselect — leaving an existence-and-ordering oracle over another tenant's
 * row. A keyset `WHERE` built from the cursor's OWN values needs no anchor read
 * at all, so both defects stop existing rather than being guarded against.
 *
 * LINKS ALREADY IN FLIGHT. Ten routes handed clients a bare row uuid as their
 * cursor and a browser tab open across the deploy still holds one. `readListCursor`
 * therefore accepts a bare uuid as a LEGACY cursor and upgrades it: the caller
 * passes a store-scoped `legacy` resolver, the row is read inside the caller's
 * own scope (never by id alone), and the keyset continues from its real ordering
 * value. A legacy id that no longer resolves is the same 404 the old
 * `scopedKeysetCursor` gave. The branch is greppable — every call site names
 * `legacy:` — so it can be deleted in one sweep once no old link can survive.
 */
import { HttpError } from "../auth/auth.errors.js";
import { UUID_PATTERN } from "./keyset-cursor.js";

/** The window every list shares. `limit` is REJECTED outside it, never clamped. */
export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;

/**
 * A decoded cursor: the ordering column's value as it was serialised, plus the
 * row id that breaks ties. Both are strings on the wire — a Date is carried as
 * its ISO form and parsed by `keysetWhere`, so the JSON has one representation.
 */
export interface ListCursor {
  readonly value: string;
  readonly id: string;
}

/** Longer than any cursor this platform mints; a floor before JSON.parse runs. */
const MAX_CURSOR_LENGTH = 512;
const CURSOR_VERSION = 1;

function invalidCursor(code: string): HttpError {
  return new HttpError(400, code, "مؤشر الصفحة غير صالح — أعِد فتح القائمة من بدايتها.");
}

/**
 * Mints the cursor for the LAST ROW OF THE PAGE — never for the un-returned
 * probe row, which would skip it.
 *
 * `kind` names the list. It is compared on the way back in, so a cursor lifted
 * from `/orders` and pasted into `/customers` is refused with a 400 instead of
 * quietly starting the customer list at an order's timestamp.
 */
export function encodeListCursor(kind: string, value: Date | string | number, id: string): string {
  const serialised = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: kind, c: serialised, i: id }),
    "utf8"
  ).toString("base64url");
}

/**
 * The shape-only decode. An absent cursor is `undefined` (the first page), not
 * an error: `?cursor=` is what an empty client-side variable serialises to and
 * that is a first page — the rule `keysetCursor` already established.
 *
 * Everything else that is not a well-formed cursor of THIS list is a 400 with a
 * stable code. Never a 500: the red team found `?cursor=abc` producing a bare
 * INTERNAL_ERROR through an unmapped Prisma P2023, and that must not come back.
 */
export function decodeListCursor(
  kind: string,
  raw: unknown,
  code = "INVALID_CURSOR"
): ListCursor | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > MAX_CURSOR_LENGTH) throw invalidCursor(code);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor(code);
  }
  const record = decoded as { v?: unknown; k?: unknown; c?: unknown; i?: unknown } | null;
  if (!record || typeof record !== "object") throw invalidCursor(code);
  if (record.v !== CURSOR_VERSION || record.k !== kind) throw invalidCursor(code);
  if (typeof record.c !== "string" || typeof record.i !== "string" || !UUID_PATTERN.test(record.i))
    throw invalidCursor(code);
  return { value: record.c, id: record.i };
}

/**
 * The decode every list route uses.
 *
 * `legacy` is the transition ramp described in the header: a bare uuid is a
 * cursor this route minted BEFORE 20-2, still sitting in an open browser tab or
 * a bookmarked link. The resolver runs inside the caller's own scope — that is
 * the whole point, and it is why the resolver is the caller's to supply — and a
 * row it cannot see is the same 404 an unreachable id gets anywhere else, so a
 * cursor can never tell «exists elsewhere» from «does not exist».
 *
 * Omit `legacy` on a list that never minted a raw-id cursor: a bare uuid there
 * is not a stale link, it is a guess, and it gets the ordinary 400.
 */
export async function readListCursor(
  kind: string,
  raw: unknown,
  options: {
    /** Lists that handed out a bare row uuid: the row is re-read in the caller's scope. */
    legacy?: (id: string) => Promise<{ value: Date | string | number } | null>;
    /**
     * Lists that already minted an ENCODED cursor of their own before 20-2 —
     * the three `{id,createdAt}` order pages and the trash bin's `deletedAt|id`
     * pipe. Tried before the strict decode, and only there; returning
     * `undefined` means «not one of mine» and the strict decode answers.
     */
    legacyEncoded?: (raw: string) => { value: Date | string | number; id: string } | undefined;
    code?: string;
  } = {}
): Promise<ListCursor | undefined> {
  const code = options.code ?? "INVALID_CURSOR";
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (options.legacy && typeof raw === "string" && UUID_PATTERN.test(raw)) {
    const row = await options.legacy(raw);
    if (!row)
      throw new HttpError(
        404,
        "RESOURCE_NOT_FOUND",
        "مؤشر الصفحة لم يعد موجوداً — أعِد فتح القائمة من بدايتها."
      );
    const value = row.value instanceof Date ? row.value.toISOString() : String(row.value);
    return { value, id: raw };
  }
  if (options.legacyEncoded && typeof raw === "string") {
    const decoded = options.legacyEncoded(raw);
    if (decoded) {
      if (!UUID_PATTERN.test(decoded.id)) throw invalidCursor(code);
      return {
        value: decoded.value instanceof Date ? decoded.value.toISOString() : String(decoded.value),
        id: decoded.id,
      };
    }
  }
  return decodeListCursor(kind, raw, code);
}

/**
 * The keyset predicate — the whole of the pagination, with no anchor read.
 *
 * `(field, id)` must be the SAME pair the query orders by, in the same
 * direction, or pages overlap or skip. The id tiebreaker is not cosmetic: a CSV
 * import writes many rows in one transaction, so `createdAt` alone leaves their
 * relative order undefined and a keyset over it repeats or drops rows.
 *
 * WHY THE REDUNDANT-LOOKING FIRST TERM (20-3). The predicate used to be the
 * bare disjunction `field < v OR (field = v AND id < i)`. It is correct, and it
 * is also the reason a keyset page still cost time proportional to how deep it
 * was: PostgreSQL cannot turn a top-level OR into an index STARTING POINT, so
 * it opened the index at the top, walked it in order, and threw away every row
 * before the cursor as a Filter. Measured on 60,000 merchants with the exact
 * composite index in place:
 *
 *     cursor at row 25      OR form 0.028 ms   ·   bounded form 0.029 ms
 *     cursor at row 30,000  OR form 3.195 ms   ·   bounded form 0.035 ms
 *     cursor at row 59,000  OR form 6.350 ms   ·   bounded form 0.033 ms
 *                                    (Rows Removed by Filter: 59,001 › 0)
 *
 * `field <= v AND (field < v OR id < i)` is the same set as
 * `field < v OR (field = v AND id < i)`, NULLs included — under the bound, the
 * only rows where `field` is NOT already past the cursor are the ties, and
 * there `id < i` is the whole test. What changes is the PLAN: that one closed
 * comparison becomes the Index Cond, so the scan opens AT the cursor and the
 * page costs the same whether it is page two or page two thousand.
 *
 * WHY `id < i` AND NOT `field = v AND id < i`. Both are correct; only one is
 * plannable. Prisma emits every occurrence of `value` as a SEPARATE bind
 * parameter, so the planner cannot see that `$2` and `$3` are the same number.
 * Given `field <= $2 AND (field < $3 OR (field = $4 AND id < $5))` it multiplies
 * the two `field` selectivities as if independent, under-estimates the row
 * count by ~50x, decomposes the OR into a BitmapOr and loses the index
 * ordering — which is a top-N sort of the whole tenant partition again. Dropping
 * the redundant `field = v` leaves one `field` term inside the OR and the
 * mis-estimate with it. Measured on the trash list, cursor at row 5,000 of
 * 10,000, same index:
 *
 *     today's OR form                 2.171 ms   Index Scan
 *     bounded, with `field = v`       3.771 ms   BitmapOr › Sort   (WORSE)
 *     bounded, without it             0.049 ms   Index Scan
 *
 * The tuple comparison `(field, id) < (v, i)` is what one would write by hand
 * (platform-pulse.service.ts does) and measures identically — Prisma's query
 * API cannot express it, which is the whole reason for this shape.
 */
export function keysetWhere(
  field: string,
  direction: "asc" | "desc",
  cursor: ListCursor | undefined,
  parse: "date" | "text" | "number" = "date"
): Record<string, unknown> {
  if (!cursor) return {};
  const value =
    parse === "date"
      ? new Date(cursor.value)
      : parse === "number"
        ? Number(cursor.value)
        : cursor.value;
  if (parse === "date" && Number.isNaN((value as Date).valueOf()))
    throw invalidCursor("INVALID_CURSOR");
  if (parse === "number" && Number.isNaN(value as number)) throw invalidCursor("INVALID_CURSOR");
  const beyond = direction === "desc" ? "lt" : "gt";
  const upTo = direction === "desc" ? "lte" : "gte";
  // `AND` rather than a top-level key: several call sites already constrain the
  // ordering column themselves (an order list filtered `createdAt` between two
  // dates, a customer segment filtered `createdAt >= …`), and a second
  // top-level `field` would silently replace theirs.
  return {
    AND: [
      { [field]: { [upTo]: value } },
      { OR: [{ [field]: { [beyond]: value } }, { id: { [beyond]: cursor.id } }] },
    ],
  };
}

/**
 * Cuts the `limit + 1` probe read into a page and its cursor.
 *
 * Reading one extra row is how «is there a page 2» is answered without a second
 * COUNT over the same predicate — the house pattern since the first keyset list.
 */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  mint: (last: T) => string
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : [...rows];
  const last = page[page.length - 1];
  return { page, nextCursor: hasMore && last !== undefined ? mint(last) : null };
}

/**
 * ONE `limit` behaviour, everywhere.
 *
 * Before this, `order-lifecycle.service.ts` was the ONLY place that rejected a
 * bad `limit`; nine other services silently clamped it. Silent clamping is how a
 * client asking for 500 rows, getting 100, and paging from a cursor it believes
 * is row 500 produces a list that skips four hundred rows and blames the server.
 * Rejecting says which value was wrong, once, in one code.
 */
export function parseListLimit(
  value: unknown,
  max = LIST_LIMIT_MAX,
  fallback = LIST_LIMIT_DEFAULT
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new HttpError(400, "INVALID_LIMIT", `limit يجب أن يكون رقماً صحيحاً بين 1 و${max}.`);
  }
  return parsed;
}
