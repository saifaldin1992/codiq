/**
 * Phase 19-أ — TOTP (RFC 6238), the owner's second factor. Decision ق-123.
 *
 * WRITTEN HERE RATHER THAN INSTALLED. The algorithm is HMAC over a time counter
 * and truncation — forty lines against a published specification, verified below
 * by the RFC's OWN test vectors. A dependency for this buys nothing and adds a
 * package with an update path into the code that guards the platform's most
 * privileged account. The test vectors are what makes writing it safe: an
 * implementation that reproduces the standard's published outputs is correct
 * against the standard, not merely correct-looking.
 *
 * SHA-1 IS RIGHT HERE, and it is worth saying why since it looks alarming. RFC
 * 6238's default is HMAC-SHA1, and every authenticator app implements that
 * default; HMAC-SHA1 is not affected by the collision attacks that ended SHA-1
 * for signatures. Choosing SHA-256 would be marginally stronger in theory and
 * silently incompatible with the app the owner actually installs — a stronger
 * hash nobody can enrol with is weaker than a standard one he can.
 */
import crypto from "node:crypto";

/** RFC 6238 default. Both are fixed rather than configurable: an authenticator
 *  app assumes them, and a setting nobody can change is not a setting. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * How many steps either side of now are accepted.
 *
 * One step — thirty seconds each way. Phone clocks drift, and a person typing a
 * code as it rolls over should not be told he is wrong. Wider would extend how
 * long a shoulder-surfed code stays usable; narrower turns ordinary clock skew
 * into a support ticket.
 */
export const TOTP_WINDOW_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648, unpadded) — the encoding every authenticator app expects. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  // Indexed rather than `for…of`: this file is reachable from BOTH tsconfigs, and
  // iterating a Buffer needs a target the root config does not set. A construct
  // that compiles under one gate and not the other is the exact asymmetry the
  // design-token PR documented — worth avoiding rather than configuring around.
  for (let index = 0; index < buffer.length; index += 1) {
    value = (value << 8) | buffer[index]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let position = 0; position < clean.length; position += 1) {
    const index = BASE32.indexOf(clean[position]!);
    if (index === -1) throw new Error("INVALID_BASE32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the RFC's recommendation and what every app handles cleanly. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for one counter value. Exported so the RFC vectors can address it. */
export function totpForCounter(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  // A 64-bit big-endian counter, written as two 32-bit halves: `writeBigUInt64BE`
  // would need a BigInt for a value that is never near 2^53 in practice.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac("sha1", secret).update(message).digest();
  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function currentStep(now: Date = new Date()): number {
  return Math.floor(now.valueOf() / 1000 / TOTP_STEP_SECONDS);
}

export interface TotpCheck {
  ok: boolean;
  /** The step the code belonged to — stored so the same code cannot be reused. */
  step: number | null;
}

/**
 * Verifies a code, and reports WHICH step it matched.
 *
 * `lastUsedStep` is what makes a code single-use. Without it a code stays valid
 * for its whole window, so anyone who reads it over a shoulder — or off a
 * screen-share — has up to ninety seconds to use it too. The caller stores the
 * returned step and passes it back next time.
 *
 * Compared with `timingSafeEqual`: a character-by-character compare leaks how
 * much of a guess was right, which over many attempts is a way to find a code.
 */
export function verifyTotp(
  secretBase32: string,
  code: unknown,
  options: { now?: Date; lastUsedStep?: number | null } = {}
): TotpCheck {
  if (typeof code !== "string") return { ok: false, step: null };
  const digits = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(digits)) return { ok: false, step: null };

  const secret = base32Decode(secretBase32);
  const centre = currentStep(options.now);
  const expected = Buffer.from(digits, "utf8");

  for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift += 1) {
    const step = centre + drift;
    // A code from a step already used is refused even though it is arithmetically
    // valid — that is the point of remembering it.
    if (
      options.lastUsedStep !== null &&
      options.lastUsedStep !== undefined &&
      step <= options.lastUsedStep
    )
      continue;
    const candidate = Buffer.from(totpForCounter(secret, step), "utf8");
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return { ok: true, step };
    }
  }
  return { ok: false, step: null };
}

/**
 * The `otpauth://` URI an authenticator app reads from a QR code.
 *
 * The issuer appears twice — once as a label prefix and once as a parameter —
 * because apps disagree about which they read, and one that shows a bare email
 * address with no idea which service it belongs to is a code nobody can find
 * again after installing three of them.
 */
export function totpEnrolmentUri(secretBase32: string, account: string, issuer = "Codiq"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
