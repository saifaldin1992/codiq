/**
 * Owner decision ق-96 — the platform addresses the merchant in the MASCULINE.
 *
 * This is not a style preference. Arabic marks gender on verbs and pronouns, so
 * a mixed surface reads as two different products talking to the same person —
 * and the cost compounds in phase 27, when every string is translated into
 * English and Kurdish from an Arabic source that must already be consistent.
 *
 * The earlier sweep converted 440 strings by hand and still left three behind
 * («أرفقي», «قومي», «وصلتِ»), which is exactly why the rule needs a guard rather
 * than a promise: the forms are too varied for one person to eyeball twice.
 *
 * Scope: user-facing source under `phase1-backend/src` and `client/src`. Code
 * comments are skipped — they address the reader of the code, not the merchant.
 * Tests are skipped for the same reason.
 *
 * When a match is a genuine false positive, add it to ALLOWED_PHRASES with its
 * reason. Never delete a form from the list to silence one line.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOTS = ["phase1-backend/src", "client/src"];
const EXTENSIONS = [".ts", ".tsx"];

/** Feminine second-person singular forms — the ones this codebase actually used. */
const FEMININE_FORMS = [
  // Imperatives.
  "أرفقي",
  "ارفقي",
  "قومي",
  "اذهبي",
  "اضغطي",
  "أدخلي",
  "ادخلي",
  "احذفي",
  "أضيفي",
  "اضيفي",
  "اختاري",
  "راجعي",
  "تأكدي",
  "حاولي",
  "أكملي",
  "اكملي",
  "اكتبي",
  "انقري",
  "أعيدي",
  "اعيدي",
  "تحققي",
  "سجّلي",
  "سجلي",
  "حدّدي",
  "حددي",
  "افتحي",
  "أغلقي",
  "اغلقي",
  "ارفعي",
  "عدّلي",
  "عدلي",
  "انتظري",
  "تابعي",
  "غيّري",
  "غيري",
  // المرحلة 20-4: two more that the list did not have, and the list is the
  // whole guard — an unenumerated form is a form that passes. Both were found
  // by generating the OpenAPI document, which publishes every Arabic error
  // message on the platform in one file and made them visible at last:
  // «أصلحي» in the CSV import's 422 (in a sentence whose NEXT verb, «أعِد», is
  // correctly masculine — ق-96's «two products talking to one person», in one
  // line) and «أنشئيها» in the analytics empty state. Neither has a
  // non-imperative reading: «إصلاحي» begins with a different hamza.
  "أصلحي",
  "اصلحي",
  "أنشئي",
  "انشئي",
  // Past tense, second person.
  "وصلتِ",
  "أدخلتِ",
  "اخترتِ",
  "حذفتِ",
  "أضفتِ",
  "سجّلتِ",
  "سجلتِ",
  // Pronouns and attached possessives.
  "أنتِ",
  "يمكنكِ",
  "لكِ",
  "بكِ",
  "منكِ",
  "إليكِ",
  "عليكِ",
  "لديكِ",
  "حسابكِ",
  "متجركِ",
  "طلبكِ",
  "بياناتكِ",
];

/**
 * THE LIST ABOVE IS A LIST OF MISTAKES ALREADY MADE. This is the rule.
 *
 * 20-4 said it plainly while adding «أصلحي» and «أنشئي»: *the enumerated list IS
 * the guard, so an unenumerated form is a form that passes*. Those two had been
 * live for weeks and surfaced only by accident — generating the OpenAPI document
 * happened to collect every Arabic error message into one file. A guard whose
 * coverage depends on someone having already been caught is not a ratchet.
 *
 * So: enumerate the MASCULINE imperatives the platform actually speaks in, and
 * derive their feminine forms mechanically. The Arabic feminine second-person
 * imperative is the masculine stem plus ي, optionally carrying an attached
 * pronoun («أنشئي» → «أنشئيها»). One verb added here covers its whole family
 * forever, including the forms nobody has written yet.
 *
 * Every stem below is a verb this codebase already addresses a person with, so
 * `stem + ي` has no plausible non-imperative reading — and `ALLOWED_PHRASES`
 * stays as the documented door for a real false positive.
 */
const MASCULINE_IMPERATIVES = [
  "أرفق",
  "ارفق",
  "قم",
  "اذهب",
  "اضغط",
  "أدخل",
  "ادخل",
  "احذف",
  "أضف",
  "اضف",
  "اختر",
  "راجع",
  "تأكد",
  "حاول",
  "أكمل",
  "اكمل",
  "اكتب",
  "انقر",
  "أعد",
  "اعد",
  "تحقق",
  "سجّل",
  "سجل",
  "حدّد",
  "حدد",
  "افتح",
  "أغلق",
  "اغلق",
  "ارفع",
  "عدّل",
  "عدل",
  "انتظر",
  "تابع",
  "غيّر",
  "غير",
  "أصلح",
  "اصلح",
  "أنشئ",
  "انشئ",
  // Verbs the platform uses today whose feminine form nobody has written yet —
  // which is exactly the point of deriving rather than listing.
  "امسح",
  "انسخ",
  "الصق",
  "أرسل",
  "ارسل",
  "استعد",
  "فعّل",
  "عطّل",
  "ابحث",
  "صفّ",
  "رتّب",
  "احفظ",
  "ألغِ",
  "الغِ",
  "أكّد",
  "اكّد",
  "أكد",
  "أوقف",
  "اوقف",
];

/**
 * A STEM WHOSE `+ي` IS AN ORDINARY WORD IS NOT ALLOWED IN THE LIST ABOVE.
 *
 * The first version of this derivation included «فعل» and immediately reported
 * three violations in correct, masculine text: «إنشاء يدوي فعلي» twice in
 * `ProductCatalogManager.tsx` and once in `OwnerDashboard.tsx` — «فعلي» there is
 * the adjective «actual», not an imperative. The platform's verb for
 * «activate» is «فعّل» WITH the shadda, and «فعّلي» collides with nothing, so the
 * un-shadda'd form is simply not one of our imperatives and was dropped.
 *
 * This matters more than the one word: a guard that fires on correct text is
 * the other way a guard stops working — people learn to ignore it, and then it
 * protects nothing while still reporting green in everyone's memory. So the bar
 * for adding a stem is that `stem + ي` has no ordinary reading. Where a real
 * collision is unavoidable, `ALLOWED_PHRASES` below is the documented door.
 */

/** Pronouns that attach to an imperative: «أنشئيها» is the form that slipped through. */
const ATTACHED_PRONOUNS = ["", "ها", "ه", "هم", "هن", "نا", "هما"];

const DERIVED_FEMININE = MASCULINE_IMPERATIVES.flatMap((stem) =>
  ATTACHED_PRONOUNS.map((pronoun) => `${stem}ي${pronoun}`)
);

/**
 * What the scan actually walks: the mistakes already made, PLUS every feminine
 * form derivable from a verb the platform speaks. Deduped, because most of the
 * hand-listed imperatives are now derived too — and that overlap is the proof
 * the derivation is right rather than a second, divergent opinion.
 */
const ALL_FEMININE_FORMS = [...new Set([...FEMININE_FORMS, ...DERIVED_FEMININE])];

/**
 * Exceptions, each with the reason it is not a second-person feminine form.
 * Empty today — kept so a real false positive gets documented rather than
 * silently dropped from the list above.
 */
const ALLOWED_PHRASES = [];

/**
 * Arabic runs its letters together, so a bare substring test reads «سجلي» out of
 * «المسجلين» and flags a perfectly masculine sentence. Every match is therefore
 * bounded by non-letters on both sides — the same idea as a word boundary, which
 * is useless here because the JS \b class does not know this script.
 */
const ARABIC_BOUNDARY = "\\u0621-\\u0652\\u0670";
const patterns = new Map();

function wordPattern(form) {
  if (!patterns.has(form)) {
    patterns.set(
      form,
      new RegExp("(?<![" + ARABIC_BOUNDARY + "])" + form + "(?![" + ARABIC_BOUNDARY + "])", "u")
    );
  }
  return patterns.get(form);
}

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

/**
 * A line that is only a comment addresses the developer, not the merchant.
 *
 * `{/*` was missing, and that is the JSX comment form — which is where a note
 * ABOUT a ق-96 fix naturally lives, right beside the string it fixed. So the
 * one file that documents an earlier correction was reported as committing it.
 * A guard that flags its own audit trail teaches people to stop reading it.
 */
function isComment(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("{/*")
  );
}

/**
 * Machine-written mirrors of strings this guard already checks at their source.
 *
 * `openapi.document.ts` is generated by `pnpm openapi:generate` and embeds every
 * Arabic error message on the platform. Scanning it reports each offending
 * string TWICE — once where a person can fix it, and once in a file where
 * editing is pointless because the next generate overwrites it. The source hit
 * is the actionable one, and it is never suppressed.
 */
const GENERATED = ["phase1-backend/src/http/openapi.document.ts"];

export function findFeminineAddress() {
  const violations = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      if (GENERATED.includes(relative(repoRoot, file).replace(/\\/g, "/"))) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        if (ALLOWED_PHRASES.some((phrase) => line.includes(phrase))) return;
        for (const form of ALL_FEMININE_FORMS) {
          if (wordPattern(form).test(line)) {
            violations.push({
              file: relative(repoRoot, file).replace(/\\/g, "/"),
              line: index + 1,
              form,
              text: line.trim().slice(0, 140),
            });
          }
        }
      });
    }
  }
  return violations;
}

export function formatFeminineAddress(violations) {
  return violations
    .map(
      (violation) =>
        `  ${violation.file}:${violation.line} — «${violation.form}» in: ${violation.text}`
    )
    .join("\n");
}

const violations = findFeminineAddress();
if (violations.length) {
  console.error(
    `ق-96: ${violations.length} string(s) address the merchant in the feminine. Rewrite them in the masculine:\n${formatFeminineAddress(violations)}`
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        suite: "copy-tone",
        status: "passed",
        summary: {
          scanned: ROOTS.join(", "),
          listed: FEMININE_FORMS.length,
          derived: DERIVED_FEMININE.length,
          forms: ALL_FEMININE_FORMS.length,
          violations: 0,
        },
      },
      null,
      2
    )
  );
}
