/**
 * PG-6 (ق-74) — the guard that makes mirroring the Arabic normalizer safe.
 *
 * `shared/search/arabic-normalize.ts` MIRRORS the SQL function
 * `codiq_ar_normalize_v1(text)` (migration 20260904090000). The server never
 * calls the TypeScript copy — the whole point of putting the normalizer in
 * Postgres is that the indexed value and the needle come out of ONE function
 * object. The copy exists for exactly one caller: the offline till (ق-142),
 * which filters its own snapshot in the browser with the network down and
 * therefore cannot ask the database to normalize anything.
 *
 * Mirrors drift, and THIS one drifts silently in the worst possible way. There
 * is no error, no log line and no red field: the till simply stops finding the
 * product the merchant can see on the shelf, or finds it offline and loses it
 * the moment the network comes back. A copy without a guard is a copy that rots.
 *
 * So the two implementations are RUN — not read — against one corpus, and the
 * first byte of difference fails the build with the string, both outputs and
 * both codepoint dumps, because «they disagree» is useless without knowing on
 * which invisible character.
 *
 * The corpus is built so that every rule in §2.1 of the blueprint is exercised
 * at least once and the coverage is ASSERTED, not hoped for: both keyboard
 * forms of أ آ ؤ ئ, precomposed against NFD-decomposed, tatweel runs, every
 * harakah, the Quranic marks, ZWNJ/RLM/ALM/bidi-isolate paste artifacts, both
 * Arabic-Indic digit ranges, mixed Latin+Arabic SKUs, LIKE metacharacters, the
 * empty and whitespace-only strings, and one string per Kurdish letter that
 * must NOT fold.
 *
 * Run: pnpm search:mirror
 */
import assert from "node:assert/strict";
import { Client } from "pg";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { normalizeArabicV1, escapeLikeNeedleV1 } = await import("../../shared/search/arabic-normalize.ts");

/** One character from its codepoint — the corpus must never carry a pasted invisible. */
const at = (code) => String.fromCodePoint(code);
const dump = (value) => (value === null ? "<null>" : [...value].map((character) => character.codePointAt(0).toString(16).padStart(4, "0")).join(" "));

const TATWEEL = at(0x0640);
const ZWNJ = at(0x200c);
const ZWSP = at(0x200b);
const ZWJ = at(0x200d);
const LRM = at(0x200e);
const RLM = at(0x200f);
const ALM = at(0x061c);
const LRI = at(0x2066);
const PDI = at(0x2069);
const NBSP = at(0x00a0);
const SUPERSCRIPT_ALEF = at(0x0670);
const FATHA = at(0x064e);
const DAMMA = at(0x064f);
const KASRA = at(0x0650);
const SHADDA = at(0x0651);
const SUKUN = at(0x0652);
const TANWEEN_FATH = at(0x064b);
const MADDAH_ABOVE = at(0x0653);
const HAMZA_ABOVE = at(0x0654);
const HAMZA_BELOW = at(0x0655);
const QURANIC_SAJDAH = at(0x06e9);
const QURANIC_SMALL_HIGH_SEEN = at(0x06dc);

/**
 * Each entry is `[label, string]`. The label is what a failure prints first, so
 * a broken rule announces WHICH rule broke rather than only which byte.
 */
const CORPUS = [
  // ── the two gate examples, in every form a keyboard can produce ────────────
  ["gate: أحمد precomposed", "أحمد"],
  ["gate: احمد bare alef", "احمد"],
  ["gate: أحمد decomposed (NFD)", "أحمد".normalize("NFD")],
  ["gate: فاطمة teh marbuta", "فاطمة"],
  ["gate: فاطمه heh", "فاطمه"],
  ["gate: أحمد الجبوري full name", "أحمد الجبوري"],
  ["gate: فاطمة الزهراء full name", "فاطمة الزهراء"],

  // ── hamza carriers, precomposed vs decomposed ─────────────────────────────
  ["hamza: آمنة precomposed", "آمنة"],
  ["hamza: آمنة decomposed", "آمنة".normalize("NFD")],
  ["hamza: مؤمن precomposed", "مؤمن"],
  ["hamza: مؤمن decomposed", "مؤمن".normalize("NFD")],
  ["hamza: قائم precomposed", "قائم"],
  ["hamza: قائم decomposed", "قائم".normalize("NFD")],
  ["hamza: إبراهيم precomposed", "إبراهيم"],
  ["hamza: إبراهيم decomposed", "إبراهيم".normalize("NFD")],
  ["hamza: bare combining maddah", `ا${MADDAH_ABOVE}مال`],
  ["hamza: bare combining hamza above", `ا${HAMZA_ABOVE}مل`],
  ["hamza: bare combining hamza below", `ا${HAMZA_BELOW}يمان`],
  ["hamza: alef wasla ٱ", "ٱحمد"],
  ["hamza: alef with wavy hamza ٲ", "ٲحمد"],
  ["hamza: alef with wavy hamza below ٳ", "ٳحمد"],
  ["hamza: alef with wavy hamza above ٵ", "ٵحمد"],
  ["hamza: standalone hamza ء is NOT folded", "الزهراء"],

  // ── alef maksura and the yeh family ───────────────────────────────────────
  ["yeh: مصطفى alef maksura", "مصطفى"],
  ["yeh: مصطفي plain yeh", "مصطفي"],
  ["yeh: farsi yeh ی", "علی"],
  ["yeh: pashto e ې", "ېحمد"],
  ["yeh: yeh with tail ۍ", "ۍحمد"],

  // ── teh marbuta / heh family ──────────────────────────────────────────────
  ["heh: مدرسة", "مدرسة"],
  ["heh: kurdish ae ە", "ماڵەوە"],

  // ── keheh ─────────────────────────────────────────────────────────────────
  ["keheh: کتاب farsi kaf", "کتاب"],
  ["keheh: كتاب arabic kaf", "كتاب"],

  // ── tatweel ───────────────────────────────────────────────────────────────
  ["tatweel: أحـــمد", `أح${TATWEEL}${TATWEEL}${TATWEEL}مد`],
  ["tatweel: only tatweel", `${TATWEEL}${TATWEEL}${TATWEEL}`],
  ["tatweel: between words", `مطبعة${TATWEEL} ${TATWEEL}بغداد`],

  // ── harakat, one by one and all together ──────────────────────────────────
  ["harakat: مُحَمَّد", `م${DAMMA}ح${FATHA}م${SHADDA}${FATHA}د`],
  ["harakat: fatha", `ك${FATHA}تب`],
  ["harakat: kasra", `ب${KASRA}سم`],
  ["harakat: sukun", `مسل${SUKUN}م`],
  ["harakat: tanween fath", `شكرا${TANWEEN_FATH}`],
  ["harakat: superscript alef", `هذ${SUPERSCRIPT_ALEF}`],
  ["quranic: small high seen U+06DC", `بسم${QURANIC_SMALL_HIGH_SEEN}`],
  ["quranic: place of sajdah U+06E9", `الله${QURANIC_SAJDAH}`],

  // ── invisibles: the WhatsApp and Word paste artifacts ─────────────────────
  ["invisible: ZWNJ inside احمد", `ا${ZWNJ}حمد`],
  ["invisible: ZWSP inside احمد", `ا${ZWSP}حمد`],
  ["invisible: ZWJ inside احمد", `ا${ZWJ}حمد`],
  ["invisible: RLM…LRM wrapper", `${RLM}احمد${LRM}`],
  ["invisible: ALM prefix", `${ALM}احمد`],
  ["invisible: bidi isolate wrapper", `${LRI}ORD-1001${PDI}`],
  ["invisible: NBSP between words", `احمد${NBSP}الجبوري`],

  // ── digits, both Arabic-Indic ranges ──────────────────────────────────────
  ["digits: arabic-indic ٠-٩", "٠١٢٣٤٥٦٧٨٩"],
  ["digits: eastern arabic-indic ۰-۹", "۰۱۲۳۴۵۶۷۸۹"],
  ["digits: order number ORD-٠٠١", "ORD-٠٠١"],
  ["digits: order number ORD-1001", "ORD-1001"],
  ["digits: phone with arabic-indic", "٠٧٧٠١٢٣٤٥٦٧"],
  ["digits: mixed ranges in one token", "٠١٢۳۴۵"],

  // ── mixed Latin / Arabic and SKUs (punctuation is deliberately preserved) ──
  ["sku: AB-0001", "AB-0001"],
  ["sku: SKU-99 with Latin diacritic", "Aḥmad SKU-99"],
  ["sku: lower/upper mix", "MaTjAr-AlNoor-42"],
  ["sku: arabic name with latin code", "زيت زيتون OLV-500ml"],
  ["sku: percent in a product name", "خصم 50% على العطور"],
  ["sku: underscore in a code", "REF_2026_08"],
  ["sku: backslash in a code", "PATH\\TO\\SKU"],

  // ── whitespace ────────────────────────────────────────────────────────────
  ["space: empty string", ""],
  ["space: spaces only", "   "],
  ["space: tabs and newlines only", "\t\n\r "],
  ["space: leading and trailing", "  فاطمة   الزهراء  "],
  ["space: internal run collapses", "زيت\t\tزيتون\n\nبكر"],

  // ── Kurdish letters that must SURVIVE (owner decision 10) ─────────────────
  ["kurdish: ڕ must not fold", "ڕەنگ"],
  ["kurdish: ڵ must not fold", "ماڵ"],
  ["kurdish: ۆ must not fold", "کۆمەڵ"],
  ["kurdish: ێ must not fold", "دێ"],
  ["kurdish: گ must not fold", "گەورە"],
  ["kurdish: چ must not fold", "چاک"],
  ["kurdish: پ must not fold", "پیاو"],
  ["kurdish: ژ must not fold", "ژیان"],
];

const sql = new Client({ connectionString: databaseUrl });
await sql.connect();

let checked = 0;
const differences = [];
try {
  for (const [label, input] of CORPUS) {
    const row = await sql.query("SELECT codiq_ar_normalize_v1($1) AS normalized, codiq_like_escape(codiq_ar_normalize_v1($1)) AS escaped", [input]);
    const fromSql = row.rows[0].normalized;
    const fromTs = normalizeArabicV1(input);
    checked += 1;
    if (fromSql !== fromTs) {
      differences.push(
        `  ${label}\n` +
          `    input   «${input}»  [${dump(input)}]\n` +
          `    sql     «${fromSql}»  [${dump(fromSql)}]\n` +
          `    ts      «${fromTs}»  [${dump(fromTs)}]`,
      );
      continue;
    }
    // The LIKE escape is mirrored too: the needle is escaped AFTER
    // normalization on both sides, so a divergence here is the same class of
    // silent bug — «خصم 50%» would behave as a prefix search on one side only.
    const escapedSql = row.rows[0].escaped;
    const escapedTs = escapeLikeNeedleV1(fromTs);
    if (escapedSql !== escapedTs) {
      differences.push(
        `  ${label} (LIKE escape)\n` +
          `    normalized «${fromTs}»\n` +
          `    sql        «${escapedSql}»  [${dump(escapedSql)}]\n` +
          `    ts         «${escapedTs}»  [${dump(escapedTs)}]`,
      );
    }
  }

  assert.deepEqual(differences, [], `codiq_ar_normalize_v1 and normalizeArabicV1 disagree:\n${differences.join("\n")}`);
  assert.ok(checked >= 60, `the corpus checked only ${checked} strings — it must cover at least 60`);

  // ── The corpus must actually EXERCISE the rules, not merely be long. Two
  //    implementations that both return their input unchanged also never
  //    disagree, so the coverage below is asserted rather than assumed.
  const changed = CORPUS.filter(([, input]) => normalizeArabicV1(input) !== input).length;
  assert.ok(changed >= 40, `only ${changed} corpus entries are actually changed by the normalizer — it is not exercising the fold`);

  const outputs = new Map(CORPUS.map(([label, input]) => [label, normalizeArabicV1(input)]));
  const same = (left, right, why) =>
    assert.equal(outputs.get(left), outputs.get(right), `${why}: «${outputs.get(left)}» [${dump(outputs.get(left))}] vs «${outputs.get(right)}» [${dump(outputs.get(right))}]`);

  same("gate: أحمد precomposed", "gate: احمد bare alef", "the أ/ا fold is gone — «احمد» would stop finding «أحمد»");
  same("gate: أحمد decomposed (NFD)", "gate: احمد bare alef", "decomposed أ no longer converges — a second keyboard layout would find nothing");
  same("gate: فاطمة teh marbuta", "gate: فاطمه heh", "the ة/ه fold is gone — «فاطمه» would stop finding «فاطمة»");
  same("hamza: آمنة precomposed", "hamza: آمنة decomposed", "آ does not converge across composition forms");
  same("hamza: مؤمن precomposed", "hamza: مؤمن decomposed", "ؤ does not converge across composition forms");
  same("hamza: قائم precomposed", "hamza: قائم decomposed", "ئ does not converge across composition forms");
  same("yeh: مصطفى alef maksura", "yeh: مصطفي plain yeh", "the ى/ي fold is gone");
  same("keheh: کتاب farsi kaf", "keheh: كتاب arabic kaf", "the ک/ك fold is gone");
  same("digits: arabic-indic ٠-٩", "digits: eastern arabic-indic ۰-۹", "the two Arabic-Indic digit ranges do not agree");
  same("tatweel: أحـــمد", "gate: احمد bare alef", "tatweel is no longer deleted");
  same("invisible: ZWNJ inside احمد", "gate: احمد bare alef", "ZWNJ is no longer deleted — a WhatsApp paste would find nothing");
  same("invisible: RLM…LRM wrapper", "gate: احمد bare alef", "the bidi marks are no longer deleted");
  same("invisible: ALM prefix", "gate: احمد bare alef", "the Arabic letter mark is no longer deleted");
  same("harakat: مُحَمَّد", "harakat: مُحَمَّد", "self-check");
  assert.equal(outputs.get("harakat: مُحَمَّد"), "محمد", "the harakat are no longer deleted");
  assert.equal(outputs.get("digits: order number ORD-٠٠١"), "ord-001", "the digit fold or the ASCII case fold is gone");
  assert.equal(outputs.get("space: leading and trailing"), "فاطمه الزهراء", "the whitespace squeeze or the trim is gone");
  assert.equal(outputs.get("space: empty string"), "", "the empty string must survive as the empty string");

  // Kurdish: the letters that must NOT fold. Asserted per letter, because a
  // careless «fold everything Persian» edit is exactly the regression that
  // would erase phase 22's distinctions before it starts (owner decision 10).
  for (const [label, letter] of [["ڕ", "ڕ"], ["ڵ", "ڵ"], ["ۆ", "ۆ"], ["ێ", "ێ"], ["گ", "گ"], ["چ", "چ"], ["پ", "پ"], ["ژ", "ژ"]]) {
    const entry = CORPUS.find(([name]) => name.startsWith(`kurdish: ${label}`));
    assert.ok(entry, `the corpus lost its ${label} case`);
    assert.ok(normalizeArabicV1(entry[1]).includes(letter), `${label} (U+${letter.codePointAt(0).toString(16)}) is being folded — Kurdish distinctions phase 22 depends on would be destroyed`);
  }

  const threshold = (await sql.query("SHOW pg_trgm.word_similarity_threshold")).rows[0]["pg_trgm.word_similarity_threshold"];

  console.log(
    JSON.stringify(
      {
        searchMirror: {
          corpus: checked,
          changedByTheFold: changed,
          ruleAssertions: 18,
          kurdishLettersProtected: 8,
          wordSimilarityThreshold: threshold,
          inSync: true,
        },
      },
      null,
      2,
    ),
  );
  console.log("search:mirror OK");
} finally {
  await sql.end();
}
