/**
 * PG-6 (ق-74) — the TypeScript MIRROR of `codiq_ar_normalize_v1(text)`
 * (migration `20260904090000_pg6_arabic_search`).
 *
 * THE SERVER DOES NOT USE THIS FILE, and that is the whole design. There is
 * exactly one normalizer on the query path — the SQL function — because the
 * indexed value and the needle must be produced by the same function object in
 * the same database. Two implementations diverging by one codepoint is how a
 * search returns zero rows with no error anywhere.
 *
 * The one place a copy is unavoidable is the offline till (ق-142): the POS
 * filters its own snapshot inside the browser and must keep working with the
 * network down, so it cannot ask Postgres to normalize anything. This file is
 * that copy, and it is kept honest the way the house already keeps the password
 * policy honest (`pnpm password:mirror`):
 *
 *   pnpm search:mirror — runs a fixed corpus through BOTH implementations and
 *   fails on the first byte of difference, printing the string, both outputs
 *   and both codepoint dumps.
 *
 * ⚠ EVERY CODEPOINT BELOW IS A NUMBER, never a pasted glyph and never a Unicode
 *   property class. `\p{Mn}` here against a hand-written range in SQL would make
 *   the guard compare two SPECIFICATIONS rather than two copies of one — and
 *   tatweel, ZWNJ and RLM are unreviewable as literals anyway. The SQL side
 *   writes the same list as `U&'\XXXX'` escapes, so the two files can be read
 *   side by side and diffed by eye.
 *
 * ⚠ The `V1` suffix is load-bearing on this side too. A STORED generated column
 *   is not recomputed when its function is replaced, so the rules change by
 *   adding a v2 pair — never by editing either half in place.
 */

/** One character from its codepoint. The source shows the number, never the (often invisible) glyph. */
const at = (code: number): string => String.fromCodePoint(code);
/** An inclusive codepoint range, ready to drop into a regex character class. */
const through = (from: number, to: number): string => `${at(from)}-${at(to)}`;

/**
 * Pass 1 — DELETE. Mirrors the SQL character class exactly, entry for entry.
 *
 * Deleting the combining marks FIRST is what makes decomposed input work with
 * no NFD pass: decomposed «أ» is `U+0627 U+0654`, which this reduces to
 * `U+0627`, and precomposed «أ» (`U+0623`) folds to the same `U+0627` in pass 2.
 * Both keyboard forms converge. Same for آ (`U+0653`), ؤ and ئ.
 *
 * The invisible range is not optional: ZWNJ and RLM arrive routinely from a
 * WhatsApp or Word paste and break matching with no visible cause.
 */
const DELETE_PATTERN = new RegExp(
  `[${[
    at(0x0640), // tatweel ـ
    through(0x064b, 0x065f), // every harakah — INCLUDING maddah U+0653, hamza-above U+0654, hamza-below U+0655
    at(0x0670), // superscript alef
    through(0x06d6, 0x06dc), // Quranic marks
    through(0x06df, 0x06e8),
    through(0x06ea, 0x06ed),
    at(0x061c), // Arabic letter mark
    through(0x200b, 0x200f), // ZWSP, ZWNJ, ZWJ, LRM, RLM
    through(0x2066, 0x2069), // bidi isolates
  ].join("")}]`,
  "g"
);

/**
 * Pass 2 — FOLD, strictly one-to-one, mirroring SQL `translate(x, FROM, TO)`.
 * The two lists are the same length by construction; the check below fails
 * loudly at module load if an edit ever breaks that, because in SQL a
 * `translate` whose TO is shorter DELETES the surplus FROM characters instead
 * of erroring — which would silently erase letters from every indexed row.
 *
 * DELIBERATELY NOT FOLDED: ڕ ڵ ۆ ێ گ چ پ ژ (U+0695, U+06B5, U+06C6, U+06CE,
 * U+06AF, U+0686, U+067E, U+0698). Those are Kurdish letters with no Arabic
 * look-alike anyone substitutes; folding them would destroy Kurdish
 * distinctions before phase 22 (ق-29, D-23) begins. Only the three look-alikes
 * an Arabic keyboard actually produces are folded — ک ی ە (owner decision 10).
 */
const FOLD_FROM_CODES = [
  0x0622,
  0x0623,
  0x0625,
  0x0671,
  0x0672,
  0x0673,
  0x0675, // آ أ إ ٱ ٲ ٳ ٵ  → ا   (gate: «احمد» ⇄ «أحمد»)
  0x0624, //                                                 ؤ            → و
  0x0626,
  0x0649,
  0x06cc,
  0x06d0,
  0x06cd, //                 ئ ى ی ې ۍ    → ي   («مصطفى» ⇄ «مصطفي»)
  0x0629,
  0x06d5, //                                         ة ە          → ه   (gate: «فاطمه» ⇄ «فاطمة»)
  0x06a9, //                                                 ک            → ك
  0x0660,
  0x0661,
  0x0662,
  0x0663,
  0x0664,
  0x0665,
  0x0666,
  0x0667,
  0x0668,
  0x0669, // ٠–٩ → 0–9
  0x06f0,
  0x06f1,
  0x06f2,
  0x06f3,
  0x06f4,
  0x06f5,
  0x06f6,
  0x06f7,
  0x06f8,
  0x06f9, // ۰–۹ → 0–9
];

const FOLD_TO_CODES = [
  0x0627, 0x0627, 0x0627, 0x0627, 0x0627, 0x0627, 0x0627, 0x0648, 0x064a, 0x064a, 0x064a, 0x064a,
  0x064a, 0x0647, 0x0647, 0x0643, 0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037,
  0x0038, 0x0039, 0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039,
];

/**
 * Pass 3 — ASCII case fold, mirroring SQL `translate(x, 'A…Z', 'a…z')` and NOT
 * `lower()`. `lower()` is collation-dependent, and a glibc or ICU upgrade under
 * a STORED generated column changes the function's output for new rows while
 * old rows keep the old value — silent, undetectable drift. `translate` cannot
 * drift, and Arabic is unicameral so nothing is lost. On this side that also
 * rules out `toLowerCase()`: it would lowercase «İ» and every other non-ASCII
 * capital that Postgres' `translate` leaves alone.
 */
const UPPER_ASCII = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER_ASCII = "abcdefghijklmnopqrstuvwxyz";

/**
 * Pass 4 — WHITESPACE. The class is explicit for the same reason the others
 * are: `\s` means one set of characters to PostgreSQL's regex engine and a
 * different set to JavaScript's, so writing `\s` on both sides would put two
 * dialects under one guard rather than two copies. The trim that follows
 * removes spaces only, exactly like `btrim(x)` with its default character set —
 * safe here because by this point every run of whitespace is a single `U+0020`.
 */
const WHITESPACE_PATTERN = new RegExp(
  `[${[
    through(0x0009, 0x000d), // tab, LF, VT, FF, CR
    at(0x0020), // space
    at(0x00a0), // no-break space — the Word-paste artifact
    through(0x2000, 0x200a), // en/em quad through hair space
    at(0x2028),
    at(0x2029),
    at(0x202f),
    at(0x205f),
    at(0x3000), // ideographic space
  ].join("")}]+`,
  "g"
);

if (FOLD_FROM_CODES.length !== FOLD_TO_CODES.length) {
  throw new Error(
    `arabic-normalize: FOLD_FROM_CODES (${FOLD_FROM_CODES.length}) and FOLD_TO_CODES (${FOLD_TO_CODES.length}) must be the same length.`
  );
}

const FOLD = new Map<string, string>();
for (let index = 0; index < FOLD_FROM_CODES.length; index += 1)
  FOLD.set(at(FOLD_FROM_CODES[index]!), at(FOLD_TO_CODES[index]!));
for (let index = 0; index < UPPER_ASCII.length; index += 1)
  FOLD.set(UPPER_ASCII[index]!, LOWER_ASCII[index]!);

/**
 * The mirror of `codiq_ar_normalize_v1`. The SQL function is STRICT, so a NULL
 * argument yields NULL; the till never has a null needle, so this side takes a
 * string and returns a string, and `search-mirror.guard.mjs` compares the two
 * over the non-null corpus.
 */
export function normalizeArabicV1(value: string): string {
  const deleted = value.replace(DELETE_PATTERN, "");
  let folded = "";
  // Iterated by UTF-16 unit rather than by code point on purpose: every mapped
  // character is in the BMP, and SQL `translate` also works one character at a
  // time, so a surrogate pair passes through both sides untouched.
  for (let index = 0; index < deleted.length; index += 1) {
    const character = deleted[index]!;
    folded += FOLD.get(character) ?? character;
  }
  return folded.replace(WHITESPACE_PATTERN, " ").replace(/^ +| +$/g, "");
}

/**
 * The mirror of `codiq_like_escape` — the SQL twin of `escapeLikeNeedle`
 * (`phase1-backend/src/services/merchant-search.service.ts:92-94`). The till
 * needs it for the same reason the server does: a merchant typing «%» must get
 * the literal answer, not the whole snapshot.
 */
export function escapeLikeNeedleV1(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The minimum needle length every surface enforces — below it a trigram index has no full trigram to stand on. */
export const SEARCH_MIN_NEEDLE_LENGTH = 2;
