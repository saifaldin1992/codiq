/**
 * ق-160 — an Iraqi shopper types `07…`, and the platform must accept it.
 *
 * FOUND BY DRIVING A LIVE DEPLOYMENT, not by reading. The rehearsal
 * (`pnpm rehearsal`) registered a shopper on staging exactly as the storefront
 * form does, and got:
 *
 *   400 INVALID_PHONE — "Phone must use E.164 format."
 *
 * The storefront's own signup field carries the placeholder `07XXXXXXXXX` and
 * sends what was typed verbatim. So the form asked an Iraqi for the number he
 * writes on paper and on shop signs, and the server refused it — at the FIRST
 * gate a shopper ever meets, on an Arabic-first platform, in English.
 *
 * WHY NO SUITE COULD SEE IT. Every existing test wrote E.164, because the
 * function demanded E.164. The tests and the code agreed with each other and
 * disagreed with the form nobody had put a test against. That is the shape of
 * defect this whole session keeps finding, and the reason the rehearsal exists.
 *
 * Run: pnpm phone:test
 */
import assert from "node:assert/strict";
import { normalizePhone, normalizeIraqiMobile, toE164 } from "../src/auth/identity.ts";

const summary = {};

// ============================================================
// 1. The form's own placeholder must work.
// ============================================================
// `07XXXXXXXXX` is literally what CustomerAuthPage.tsx asks for.
assert.equal(
  normalizePhone("07701234567"),
  "+9647701234567",
  "the shape the signup field asks for must be accepted"
);
assert.equal(
  normalizePhone("0770 123 4567"),
  "+9647701234567",
  "…spaces and all, because people type spaces"
);
assert.equal(normalizePhone("0770-123-4567"), "+9647701234567", "…and dashes");
summary.localForm = "07XXXXXXXXX and its punctuated variants normalise to +964…";

// ============================================================
// 2. EVERY INPUT THAT USED TO SUCCEED STILL NORMALISES IDENTICALLY.
// ============================================================
// This is what makes the widening safe: it changes refusals into acceptances
// and changes nothing else. A stored `phoneNormalized` keeps its meaning, so
// customer sign-in still finds the row registration created.
assert.equal(normalizePhone("+9647701234567"), "+9647701234567", "E.164 is unchanged");
assert.equal(normalizePhone("009647701234567"), "+9647701234567", "the 00 prefix still becomes +");
assert.equal(
  normalizePhone("+14155552671"),
  "+14155552671",
  "a non-Iraqi E.164 number passes through untouched"
);
assert.equal(
  normalizePhone(" +964 770 123 4567 "),
  "+9647701234567",
  "surrounding space and separators still stripped"
);
summary.backwardCompatible = "every previously-accepted input yields the same value it did before";

// ============================================================
// 3. Registration and sign-in must agree — or an account is unreachable.
// ============================================================
// The account is stored under one key. If the two doors normalised differently,
// a shopper would register successfully and then be unable to sign in, with
// «wrong password» as the only clue.
for (const typed of ["07701234567", "+9647701234567", "0770 123 4567", "009647701234567"]) {
  assert.equal(
    normalizePhone(typed),
    "+9647701234567",
    `every way of writing one number must reach one row: ${typed}`
  );
}
summary.oneNumberOneRow = "four ways of writing the same number all resolve to one stored value";

// ============================================================
// 4. Nonsense is still refused — and now in Arabic.
// ============================================================
for (const bad of ["", "abc", "123", "07", "0770123", null, undefined, 7701234567]) {
  assert.throws(
    () => normalizePhone(bad),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "INVALID_PHONE");
      assert.ok(
        !/[A-Za-z]/.test(error.message.replace(/[0-9X+\s.]/g, "")),
        `the refusal must be Arabic — ق-96: ${error.message}`
      );
      assert.ok(
        error.message.includes("07XXXXXXXXX"),
        "…and must show the shape it wants, since the person is looking at a rejected field"
      );
      return true;
    },
    `refused: ${JSON.stringify(bad)}`
  );
}
summary.stillStrict =
  "empty, short, lettered and non-string values are refused, in Arabic, naming the accepted shapes";

// ============================================================
// 5. The merchant's rule stays STRICTER, on purpose.
// ============================================================
// `normalizeIraqiMobile` is a sign-in identity and a cash-on-delivery channel:
// it refuses landlines and foreign numbers, and that is deliberate. Widening the
// customer helper must not have widened it too.
assert.equal(normalizeIraqiMobile("07701234567"), "+9647701234567");
assert.throws(
  () => normalizeIraqiMobile("+14155552671"),
  /INVALID_MERCHANT_PHONE|موبايل/,
  "a foreign number is not a COD channel for an Iraqi courier"
);
assert.throws(
  () => normalizeIraqiMobile("+96412345678"),
  /INVALID_MERCHANT_PHONE|موبايل/,
  "a landline is refused on purpose"
);
summary.merchantStaysStrict = "the merchant identity rule is untouched: Iraqi mobiles only";

// ============================================================
// 6. The permissive core is the one shared implementation.
// ============================================================
// ق-06 applied to a function: written once, used, never copied a third time.
assert.equal(toE164("07701234567"), "+9647701234567");
assert.equal(
  toE164("nonsense"),
  null,
  "the core NEVER throws — its callers decide what a failure means"
);
summary.oneCore = "normalizePhone and normalizeIraqiMobile both sit on toE164";

console.log(JSON.stringify({ suite: "phone-normalisation", status: "passed", summary }, null, 2));
