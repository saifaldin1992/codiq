/**
 * codiq phase 19-أ — the password policy (owner's decision: minimum 8).
 *
 * The floor came DOWN from twelve to eight, so the burden of proof is on this
 * file: it has to show the platform is not weaker afterwards. The argument is
 * that a length rule stops nothing anyone actually chooses, and that refusing
 * the passwords people actually pick is worth more than four extra characters.
 * These assertions are that argument, made checkable:
 *
 *   1. EIGHT IS ACCEPTED, seven is not — the owner's rule, exactly;
 *   2. NO COMPOSITION RULES — eight lowercase letters pass, and so do eight
 *      digits that are not a pattern. Demanding a capital and a symbol is what
 *      produces «Password1!», which is the corner attackers search first;
 *   3. THE PASSWORDS PEOPLE ACTUALLY PICK ARE REFUSED — «12345678» is eight
 *      characters and would have been legal under a naive floor of eight;
 *   4. THIS IS STRICTER THAN THE OLD RULE IN THE CASES THAT MATTER —
 *      «passwordpassword» passed the twelve-character minimum and fails here;
 *   5. THE DISGUISES DO NOT WORK — «P@ssw0rd» is «password» wearing a hat;
 *   6. A REAL PASSWORD IS NOT REFUSED — the check that none of the above passes
 *      by being indiscriminate, which would be its own kind of failure;
 *   7. A RECOVERY CODE STILL HASHES — it goes through this same function, and a
 *      policy that rejected the owner's way back into his own platform would be
 *      discovered at the worst possible moment.
 */
import assert from "node:assert/strict";

const { assertPasswordAcceptable, PASSWORD_MIN_LENGTH } = await import("../src/auth/password-policy.ts");

const refusalOf = (password) => {
  try {
    assertPasswordAcceptable(password);
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
};
const accepts = (password) => refusalOf(password) === null;

// 1. The floor is exactly where the owner put it.
assert.equal(PASSWORD_MIN_LENGTH, 8, "the owner set the floor at 8");
assert.equal(refusalOf("shrt1a"), "WEAK_PASSWORD", "six characters is refused");
assert.equal(refusalOf("shrt1ab"), "WEAK_PASSWORD", "seven is refused");
assert.ok(accepts("shrt1abc"), "…and eight is accepted — the floor is at 8, not 9");

// 2. No composition rules. The owner said "letters or digits or symbols", and
//    that is what this means: what the characters ARE is not the platform's
//    business.
assert.ok(accepts("khamsatun"), "eight-plus lowercase letters, no digit, no symbol — accepted");
assert.ok(accepts("29471638"), "digits only, no pattern — accepted");
assert.ok(accepts("!!$$&&**##"), "symbols only — accepted");
assert.ok(accepts("مرحبابكم في متجري"), "an Arabic passphrase — accepted, on an Arabic-first platform");

// 3. The ones people actually pick. Every one of these clears eight characters,
//    so a naive floor of eight would have let all of them through.
for (const guessed of ["password", "12345678", "qwerty123", "iloveyou", "admin123", "welcome1", "trustno1"]) {
  assert.ok(guessed.length >= PASSWORD_MIN_LENGTH, `«${guessed}» clears the floor, so only the list can refuse it`);
  assert.equal(refusalOf(guessed), "COMMON_PASSWORD", `«${guessed}» is refused — it is the first thing tried`);
}
// Length is checked BEFORE the list, so a short common password is refused for
// being short. Both are refusals; saying "too common" about something that is
// also too short would tell the person the wrong thing to fix.
assert.equal(refusalOf("letmein"), "WEAK_PASSWORD", "«letmein» is seven characters — the length is what he must fix first");
// The ones no bought list carries, because they are about this platform and
// this country.
for (const local of ["codiq123", "baghdad123", "bismillah", "alrafidain", "cashondelivery", "kurdistan"]) {
  assert.ok(local.length >= PASSWORD_MIN_LENGTH, `«${local}» clears the floor, so only the list can refuse it`);
  assert.equal(refusalOf(local), "COMMON_PASSWORD", `«${local}» is refused — a generic list would miss it`);
}

// 4. Stricter than what it replaced, in the cases that matter. Each of these is
//    twelve or more characters and passed the OLD rule outright.
for (const passedBefore of ["passwordpassword", "password1234", "123456789012", "abcabcabcabc", "aaaaaaaaaaaa"]) {
  assert.ok(passedBefore.length >= 12, `«${passedBefore}» cleared the old twelve-character floor`);
  assert.equal(refusalOf(passedBefore), "COMMON_PASSWORD", `…and is refused now — the policy got STRICTER here`);
}

// 5. The disguises. Undoing the substitutions is what stops the list being
//    side-stepped by somebody who thinks he has been clever.
for (const disguised of ["P@ssw0rd", "p4ssw0rd", "PASSWORD", "Adm1n123", "1l0v3y0u"]) {
  assert.equal(refusalOf(disguised), "COMMON_PASSWORD", `«${disguised}» is the same password wearing a hat`);
}

// 6. …and none of that is achieved by refusing everything. A policy that says no
//    too often teaches people to pick the first thing it accepts.
for (const real of [
  "burtuqal-jamil-2026",
  "MatjarAlNoor!47",
  "correcthorsebattery",
  "s9Kd2mQ",              // seven — refused for LENGTH, not for being common
  "zaytoun.wa.laymoon",
  "T4jir-Baghdad-88",
]) {
  const refusal = refusalOf(real);
  if (real === "s9Kd2mQ") {
    assert.equal(refusal, "WEAK_PASSWORD", "seven characters is refused for its length, not called common");
  } else {
    assert.equal(refusal, null, `«${real}» is a real password and must be accepted`);
  }
}

// A sequential run is caught structurally rather than listed, so it holds at any
// starting point and any length.
assert.equal(refusalOf("abcdefgh"), "COMMON_PASSWORD", "a straight run up the alphabet");
assert.equal(refusalOf("87654321"), "COMMON_PASSWORD", "…and down the number line");
assert.equal(refusalOf("defghijklmn"), "COMMON_PASSWORD", "…from anywhere, at any length");
assert.ok(accepts("acegikmoq"), "…but skipping is not a run — this is a real password");

// 7. A recovery code must still hash. It goes through this same function, and it
//    is the owner's way back into his own platform.
const RECOVERY_SHAPE = /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/;
const sample = "K7M2P-QR4TV-9XZBN";
assert.ok(RECOVERY_SHAPE.test(sample), "the shape the enrolment actually mints");
assert.ok(accepts(sample.replace(/-/g, "")), "a recovery code is accepted — it is normalised before hashing");
assert.ok(accepts(sample), "…and in its dashed form too");

console.log(
  JSON.stringify(
    {
      passwordPolicy: {
        minimum: PASSWORD_MIN_LENGTH,
        compositionRules: "none — letters or digits or symbols, as the owner asked",
        refusesCommonPasswords: true,
        refusesLeetDisguises: true,
        refusesStructuralPatterns: ["single character", "sequential run", "repeated unit"],
        stricterThanOldTwelveCharRuleFor: ["passwordpassword", "password1234", "aaaaaaaaaaaa"],
        recoveryCodesStillHash: true,
      },
    },
    null,
    2,
  ),
);
console.log("password:policy OK");
