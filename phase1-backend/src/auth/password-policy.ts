/**
 * Phase 19-أ — what makes a password acceptable. The platform's ONE policy.
 *
 * ============================================================================
 * EIGHT, NOT TWELVE — AND WHY THAT IS NOT A WEAKENING
 * ============================================================================
 *
 * The owner asked for eight. That is the right call, and it is worth writing
 * down why rather than treating it as a concession.
 *
 * A length floor buys far less than it appears to. It stops nothing that a
 * person actually chooses: «12345678» is eight characters, and so is
 * «password». Raising the floor to twelve does not make people pick better
 * passwords — it makes them pick «password1234», write it on a note, or reuse
 * the one they already use everywhere. Mainstream guidance moved years ago from
 * "longer and with a symbol in it" to "eight minimum, and REFUSE THE ONES
 * PEOPLE ACTUALLY PICK", precisely because the second is what attackers try.
 *
 * So the floor comes down to eight AND the guessing list goes in. Without the
 * list this change would genuinely weaken the platform, because «12345678»
 * would become a legal password for a merchant who handles other people's cash.
 * With it, this is stricter than what came before: «passwordpassword» passed the
 * twelve-character rule and fails this one.
 *
 * NO COMPOSITION RULES. Nothing here demands an uppercase letter or a symbol.
 * Those rules are why people end with «Password1!» — they push everyone into
 * the same tiny corner of the keyspace, which is the corner attackers search
 * first. The owner's phrasing — "letters or digits or symbols" — is exactly
 * right: what the characters ARE is not the platform's business.
 *
 * ============================================================================
 * WHAT ELSE HAS TO BE TRUE FOR EIGHT TO BE SAFE
 * ============================================================================
 *
 * Guessing is online, not offline, so it is bounded by the rate limit already
 * on every login route (30 attempts per 10 minutes) and by bcrypt at cost 12.
 * The list below closes the gap those two leave open: an attacker who only ever
 * tries the two hundred passwords people actually use.
 *
 * THE OWNER'S ACCOUNT IS THE ONE EXCEPTION WORTH ARGUING ABOUT, and it is
 * handled elsewhere and better: he has TOTP (ق-123). A second factor is worth
 * more than four extra characters, and unlike a length rule it defends against
 * a password that leaked rather than one that was guessed.
 */
import { HttpError } from "./auth.errors.js";
import { isBreachedCommonPassword } from "./breached-passwords.js";

/** The floor, in characters. Set by the owner. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * A ceiling exists so nobody can post a megabyte and make bcrypt chew on it.
 * bcrypt itself only reads the first 72 bytes, so this is about the server, not
 * about the password.
 */
export const PASSWORD_MAX_LENGTH = 200;

/**
 * The passwords people actually choose.
 *
 * Not a dictionary — a dictionary would reject «correcthorsebattery», which is
 * a fine password. This is the short list an attacker tries FIRST, drawn from
 * what repeatedly tops real breach corpora, plus the ones specific to this
 * platform and this country that no generic list would carry.
 *
 * Kept deliberately small and readable. A hundred-thousand-entry list bought in
 * would need a dependency, a load, and a licence, and would catch very little
 * more: the tail of that distribution is long and flat, and the rate limit
 * already covers it.
 */
const COMMON_PASSWORDS = new Set([
  // The perennial top of every breach corpus.
  "password", "passwords", "password1", "password12", "password123", "password1234",
  "passwordpassword", "mypassword", "newpassword", "letmein", "welcome", "welcome1",
  "admin", "admin123", "administrator", "root", "toor", "guest", "test", "test123",
  "qwerty", "qwerty123", "qwertyuiop", "azerty", "asdfgh", "asdfghjk", "zxcvbnm",
  "1q2w3e4r", "1qaz2wsx", "qazwsx", "q1w2e3r4", "abc12345", "a1b2c3d4",
  "iloveyou", "princess", "sunshine", "football", "baseball", "superman", "batman",
  "monkey", "dragon", "master", "shadow", "michael", "jennifer", "jordan", "harley",
  "trustno1", "starwars", "computer", "internet", "samsung", "google", "facebook",
  "whatsapp", "instagram", "snapchat", "telegram",
  "changeme", "secret", "secret123", "default", "temporary", "temppass", "temppass1",
  "login", "logmein", "access", "freedom", "whatever", "nothing", "nopassword",
  // Numeric and keyboard runs that the structural rules below would mostly
  // catch, listed too because a person adds one character and slips past them.
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000",
  "12341234", "12121212", "10203040", "13131313", "112233", "1122334455",
  "123123123", "121212", "789456123", "147258369", "159753",
  // This platform, this country, this business. No bought list carries these.
  "codiq", "codiq123", "codiq2026", "codiqadmin", "codiqstore", "codiqpass",
  "iraq", "iraq2026", "baghdad", "baghdad123", "basra", "erbil", "mosul", "najaf",
  "karbala", "kirkuk", "samarra", "fallujah", "ramadi", "tikrit", "duhok",
  "almustafa", "alnoor", "alrafidain", "dijla", "furat", "babil", "sumer",
  "store", "store123", "mystore", "shop", "shop123", "myshop", "market",
  "merchant", "merchant1", "business", "company", "delivery", "cash", "cashondelivery",
  // Transliterated Arabic that people genuinely use.
  "habibi", "habibti", "salam", "salamalikum", "assalam", "marhaba", "ahlan",
  "allah", "bismillah", "alhamdulillah", "mohammed", "muhammad", "ahmed", "ahmad",
  "hassan", "hussein", "ali123", "fatima", "zainab", "mariam", "yousef", "omar123",
  "iraqi", "arabi", "arabic", "baghdadi", "kurdistan", "kurdi",
]);

/**
 * Undoes the substitutions people believe make a password strong.
 *
 * «P@ssw0rd» is «password» wearing a hat, and every cracking tool has known
 * that for twenty years. Checking the normalised form as WELL as the literal
 * one is what stops the list above from being trivially side-stepped by
 * somebody who thinks he has been clever.
 */
function deLeet(value: string): string {
  return value
    .replace(/[@4]/g, "a")
    .replace(/[3€]/g, "e")
    .replace(/[10!|]/g, (match) => (match === "0" ? "o" : "i"))
    .replace(/[$5]/g, "s")
    .replace(/7/g, "t")
    .replace(/[8]/g, "b")
    .replace(/[+]/g, "t");
}

/** One character repeated: «aaaaaaaa», «11111111». */
function isSingleCharacter(value: string): boolean {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== value[0]) return false;
  }
  return true;
}

/**
 * A straight run up or down the keyboard or the number line: «12345678»,
 * «abcdefgh», «87654321». Checked structurally rather than listed, because the
 * list would have to hold every starting point and every length.
 */
function isSequentialRun(value: string): boolean {
  if (value.length < 4) return false;
  let ascending = true;
  let descending = true;
  for (let index = 1; index < value.length; index += 1) {
    const step = value.charCodeAt(index) - value.charCodeAt(index - 1);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }
  if (ascending || descending) return true;

  // Digits WRAP. «1234567890» is one of the most used passwords on earth and the
  // plain check above misses it, because the step from 9 to 0 is minus nine —
  // so the run is followed round the number line instead of off the end of it.
  if (!/^[0-9]+$/.test(value)) return false;
  let wrapUp = true;
  let wrapDown = true;
  for (let index = 1; index < value.length; index += 1) {
    const previous = value.charCodeAt(index - 1) - 48;
    const current = value.charCodeAt(index) - 48;
    if (current !== (previous + 1) % 10) wrapUp = false;
    if (current !== (previous + 9) % 10) wrapDown = false;
  }
  return wrapUp || wrapDown;
}

/** A short pattern typed over and over: «abcabcabc», «12121212». */
function isRepeatedPattern(value: string): boolean {
  for (let size = 1; size <= Math.floor(value.length / 2); size += 1) {
    if (value.length % size !== 0) continue;
    const unit = value.slice(0, size);
    if (unit.repeat(value.length / size) === value) return true;
  }
  return false;
}

/**
 * Throws if the password is one the platform will not accept.
 *
 * Two distinct codes on purpose. "Too short" and "everybody uses that one" are
 * different problems with different fixes, and a person told only "invalid
 * password" will retry with something equally guessable. The messages say what
 * to do, in Arabic, because this is an Arabic-first platform and a person
 * choosing a password is exactly who a Latin-script error fails.
 */
export function assertPasswordAcceptable(password: unknown): string {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(
      400,
      "WEAK_PASSWORD",
      `كلمة المرور يجب أن تتكون من ${PASSWORD_MIN_LENGTH} خانات على الأقل — حروف أو أرقام أو رموز، كما تشاء.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, "WEAK_PASSWORD", `كلمة المرور أطول من ${PASSWORD_MAX_LENGTH} خانة.`);
  }

  // Several normalised forms are checked, not one. Each undoes a different thing
  // people do to a common word while believing it is now a password:
  //
  //   lowered            — «PASSWORD»
  //   deLeet             — «P@ssw0rd», the same word wearing a hat
  //   trailing digits    — «admin2026», «alnoor123». This is the big one:
  //                        appending a year or a birthday is the single most
  //                        common thing anyone does, and no list can enumerate
  //                        it. Stripping the suffix and re-checking catches the
  //                        whole family from one entry.
  //
  // The stripped form is only consulted when what remains is still a real word,
  // so «29471638» does not decay to nothing and match by accident.
  // Applied as a CLOSURE rather than as two fixed passes, because the
  // transformations compose: «Adm1n123» needs its suffix stripped AND then the
  // «1» read as an «i» before it becomes «admin». Doing them in a fixed order
  // catches one arrangement and misses the other.
  // An ARRAY, not a Set: spreading a Set needs a target the root tsconfig does
  // not set, and this file is reachable from both gates. The list is a handful
  // of strings, so `includes` costs nothing.
  const lowered = password.toLowerCase();
  const forms: string[] = [lowered];
  const remember = (form: string) => {
    if (!forms.includes(form)) forms.push(form);
  };
  for (let round = 0; round < 3; round += 1) {
    for (let index = forms.length - 1; index >= 0; index -= 1) {
      const form = forms[index]!;
      remember(deLeet(form));
      const withoutSuffix = form.replace(/[0-9]+$/, "");
      // Only when what remains is still a word: «29471638» must not decay to
      // nothing and match something by accident.
      if (withoutSuffix.length >= 4) remember(withoutSuffix);
    }
  }

  const tooCommon =
    forms.some((form) => COMMON_PASSWORDS.has(form)) ||
    // The ten-thousand breach list: exact match only, so a password that merely
    // CONTAINS a common word is not refused for reasons nobody could guess.
    isBreachedCommonPassword(lowered) ||
    isSingleCharacter(lowered) ||
    isSequentialRun(lowered) ||
    isRepeatedPattern(lowered);

  if (tooCommon) {
    throw new HttpError(
      400,
      "COMMON_PASSWORD",
      "هذه من أكثر كلمات المرور استعمالاً، وهي أول ما يُجرَّب. اختر شيئاً لا يخمّنه أحد — عبارة قصيرة تذكرها أنت وحدك تكفي.",
    );
  }
  return password;
}
