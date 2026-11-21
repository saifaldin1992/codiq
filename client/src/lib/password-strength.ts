/**
 * codiq — reading a password's strength in the browser, for the meter under the
 * field (owner request, 2026-08-31).
 *
 * ============================================================================
 * THE ONE RULE THIS FILE MUST NEVER BREAK
 * ============================================================================
 *
 * THE BAR MUST NEVER SAY «قوية» ABOUT SOMETHING THE SERVER WILL REFUSE. That is
 * the failure mode of every strength meter that has ever annoyed anybody: it
 * fills up green, the person presses «إنشاء», and the server answers with a red
 * error about a rule the meter never mentioned. So acceptance is checked FIRST
 * and it dominates — a password the server would reject reads as rejected here,
 * with the same reason, before any scoring happens.
 *
 * ============================================================================
 * WHY THE CONSTANTS ARE MIRRORED, AND WHY THAT IS SAFE HERE
 * ============================================================================
 *
 * The rules below MIRROR `phase1-backend/src/auth/password-policy.ts`, which
 * stays the sole authority — exactly as `navigation.ts` mirrors the server's
 * permission codes. The backend's tsconfig covers only its own `src`, so it
 * cannot import from `shared/`, and a genuinely shared module would mean
 * changing that project's module resolution and its build.
 *
 * Mirroring drifts. So it is not left to vigilance: `password-mirror.guard.mjs`
 * reads BOTH files and fails CI if this list and the server's stop being
 * identical. A mirror with a guard is a copy that cannot rot; a mirror without
 * one is a bug with a comment on it.
 *
 * Shipping the list to the browser costs nothing and reveals nothing — every
 * entry is a password already in every public breach corpus. What it buys is an
 * answer with no round trip, on a keystroke, on a phone, on Iraqi mobile data.
 */

/** Mirrors PASSWORD_MIN_LENGTH. */
export const PASSWORD_MIN_LENGTH = 8;

/** Mirrors PASSWORD_MAX_LENGTH. */
export const PASSWORD_MAX_LENGTH = 200;

/** Length past which extra characters stop moving the meter. */
const STRONG_LENGTH = 16;

/** Mirrors COMMON_PASSWORDS. Kept in the same order for a readable diff. */
export const COMMON_PASSWORDS: string[] = [
  "password",
  "passwords",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passwordpassword",
  "mypassword",
  "newpassword",
  "letmein",
  "welcome",
  "welcome1",
  "admin",
  "admin123",
  "administrator",
  "root",
  "toor",
  "guest",
  "test",
  "test123",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "azerty",
  "asdfgh",
  "asdfghjk",
  "zxcvbnm",
  "1q2w3e4r",
  "1qaz2wsx",
  "qazwsx",
  "q1w2e3r4",
  "abc12345",
  "a1b2c3d4",
  "iloveyou",
  "princess",
  "sunshine",
  "football",
  "baseball",
  "superman",
  "batman",
  "monkey",
  "dragon",
  "master",
  "shadow",
  "michael",
  "jennifer",
  "jordan",
  "harley",
  "trustno1",
  "starwars",
  "computer",
  "internet",
  "samsung",
  "google",
  "facebook",
  "whatsapp",
  "instagram",
  "snapchat",
  "telegram",
  "changeme",
  "secret",
  "secret123",
  "default",
  "temporary",
  "temppass",
  "temppass1",
  "login",
  "logmein",
  "access",
  "freedom",
  "whatever",
  "nothing",
  "nopassword",
  "12345678",
  "123456789",
  "1234567890",
  "87654321",
  "11111111",
  "00000000",
  "12341234",
  "12121212",
  "10203040",
  "13131313",
  "112233",
  "1122334455",
  "123123123",
  "121212",
  "789456123",
  "147258369",
  "159753",
  "codiq",
  "codiq123",
  "codiq2026",
  "codiqadmin",
  "codiqstore",
  "codiqpass",
  "iraq",
  "iraq2026",
  "baghdad",
  "baghdad123",
  "basra",
  "erbil",
  "mosul",
  "najaf",
  "karbala",
  "kirkuk",
  "samarra",
  "fallujah",
  "ramadi",
  "tikrit",
  "duhok",
  "almustafa",
  "alnoor",
  "alrafidain",
  "dijla",
  "furat",
  "babil",
  "sumer",
  "store",
  "store123",
  "mystore",
  "shop",
  "shop123",
  "myshop",
  "market",
  "merchant",
  "merchant1",
  "business",
  "company",
  "delivery",
  "cash",
  "cashondelivery",
  "habibi",
  "habibti",
  "salam",
  "salamalikum",
  "assalam",
  "marhaba",
  "ahlan",
  "allah",
  "bismillah",
  "alhamdulillah",
  "mohammed",
  "muhammad",
  "ahmed",
  "ahmad",
  "hassan",
  "hussein",
  "ali123",
  "fatima",
  "zainab",
  "mariam",
  "yousef",
  "omar123",
  "iraqi",
  "arabi",
  "arabic",
  "baghdadi",
  "kurdistan",
  "kurdi",
];

const COMMON = new Set(COMMON_PASSWORDS);

/** Mirrors deLeet. */
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

/** Mirrors isSingleCharacter. */
function isSingleCharacter(value: string): boolean {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== value[0]) return false;
  }
  return true;
}

/** Mirrors isSequentialRun, including the digit wrap past 9. */
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

/** Mirrors isRepeatedPattern. */
function isRepeatedPattern(value: string): boolean {
  for (let size = 1; size <= Math.floor(value.length / 2); size += 1) {
    if (value.length % size !== 0) continue;
    const unit = value.slice(0, size);
    if (unit.repeat(value.length / size) === value) return true;
  }
  return false;
}

/** Mirrors the normalisation closure in the server policy. */
function isCommon(password: string): boolean {
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
      if (withoutSuffix.length >= 4) remember(withoutSuffix);
    }
  }
  return (
    forms.some((form) => COMMON.has(form)) ||
    isSingleCharacter(lowered) ||
    isSequentialRun(lowered) ||
    isRepeatedPattern(lowered)
  );
}

/** 0 is "the server would refuse this"; 1…4 are shades of accepted. */
export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export interface StrengthCheck {
  id: string;
  /** Written as a thing to DO, not a rule that was broken. */
  label: string;
  met: boolean;
  /** A required rule versus a suggestion that only adds strength. */
  required: boolean;
}

export interface PasswordAssessment {
  /** Whether the server would accept it. The meter never contradicts this. */
  accepted: boolean;
  level: StrengthLevel;
  label: string;
  /** Present only when it would be refused — the same reason the server gives. */
  reason: string | null;
  checks: StrengthCheck[];
  /** True before anything is typed: show the guidance, hide the bar. */
  empty: boolean;
}

/** How many different kinds of character appear. Measured, never REQUIRED. */
function characterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  // ASCII punctuation only, so a non-Latin letter is not counted twice — once
  // as a «symbol» here and again as its own script below.
  if (/[^a-zA-Z0-9\u0080-\uFFFF]/.test(password)) classes += 1;
  // Arabic, and every other script, counts as its own kind. Without this an
  // Arabic passphrase scores as though it contained nothing at all — on a
  // platform whose people write Arabic.
  if (/[\u0080-\uFFFF]/.test(password)) classes += 1;
  return classes;
}

const LABELS: Record<StrengthLevel, string> = {
  0: "غير مقبولة",
  1: "ضعيفة",
  2: "متوسطة",
  3: "قوية",
  4: "قوية جداً",
};

export function assessPassword(password: string): PasswordAssessment {
  const length = password.length;
  const longEnough = length >= PASSWORD_MIN_LENGTH;
  const notCommon = length > 0 && !isCommon(password);

  const checks: StrengthCheck[] = [
    {
      id: "length",
      label: `${PASSWORD_MIN_LENGTH} خانات على الأقل`,
      met: longEnough,
      required: true,
    },
    { id: "common", label: "ليست من كلمات المرور الشائعة", met: notCommon, required: true },
    // Suggestions, not rules. The owner asked for no composition requirements,
    // so these say what would make it STRONGER and refusing them costs nothing.
    {
      id: "longer",
      label: "12 خانة أو أكثر تجعلها أقوى بكثير",
      met: length >= 12,
      required: false,
    },
    {
      id: "variety",
      label: "خلط الحروف والأرقام والرموز يزيدها قوة",
      met: characterClasses(password) >= 2,
      required: false,
    },
  ];

  if (length === 0) {
    return { accepted: false, level: 0, label: "", reason: null, checks, empty: true };
  }

  if (!longEnough) {
    return {
      accepted: false,
      level: 0,
      label: LABELS[0],
      reason: `أقصر من ${PASSWORD_MIN_LENGTH} خانات.`,
      checks,
      empty: false,
    };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return {
      accepted: false,
      level: 0,
      label: LABELS[0],
      reason: `أطول من ${PASSWORD_MAX_LENGTH} خانة.`,
      checks,
      empty: false,
    };
  }
  if (!notCommon) {
    return {
      accepted: false,
      level: 0,
      label: LABELS[0],
      reason: "هذه من أكثر كلمات المرور استعمالاً، وهي أول ما يُجرَّب.",
      checks,
      empty: false,
    };
  }

  // Accepted. Now — and only now — how strong.
  //
  // Length carries most of the weight because it genuinely does: a long
  // passphrase of ordinary words beats a short one full of symbols, and telling
  // people otherwise is how «P@ss1!» came to be believed strong.
  let score = 0;
  if (length >= 10) score += 1;
  if (length >= 12) score += 1;
  if (length >= STRONG_LENGTH) score += 1;
  if (characterClasses(password) >= 3) score += 1;

  const level = Math.min(4, Math.max(1, score)) as StrengthLevel;
  return { accepted: true, level, label: LABELS[level], reason: null, checks, empty: false };
}
