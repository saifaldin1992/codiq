/**
 * One-time codes for the market (Marketplace M4): signing in by phone, and
 * proving a delivery address's phone belongs to someone who can answer it.
 *
 * THE RULES, each enforced here and proven in market-account.integration.mjs:
 *   · six digits from a CSPRNG; stored only as HMAC-SHA256 under the `otp` key
 *     derived from the session secret (a leaked row is not a code);
 *   · five minutes to live, five tries, one use — the try counter moves in the
 *     same UPDATE that checks it, so parallel guesses cannot share a try;
 *   · a new code for the same phone at most once a minute, five an hour, and
 *     twenty per IP an hour, so the endpoint cannot be used to flood a number
 *     with SMS or to enumerate who has an account (the answer never says);
 *   · delivered by an OtpProvider. Until the platform picks an SMS/WhatsApp
 *     provider (docs/MARKETPLACE_PLAN.md §4), development logs the code; a
 *     deployed environment refuses with 503 unless the operator explicitly opts
 *     into the insecure log provider (CODIQ_OTP_PROVIDER=insecure-log) for a
 *     test environment.
 */
import crypto from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { buildKeys } from "../../auth/keys.js";
import { config } from "../../config.js";
import { logger } from "../../logging/logger.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_AFTER_MS = 60 * 1000;
const OTP_KEYS = buildKeys(config.sessionJwtSecret, config.sessionJwtSecretPrevious).otp;

export type OtpPurpose = "login" | "address_phone";

export interface OtpProvider {
  readonly name: string;
  send(phoneE164: string, code: string, purpose: OtpPurpose): Promise<void>;
}

/** Writes the code to the server log. Development, or a test environment that asked for it by name. */
const logProvider: OtpProvider = {
  name: "log",
  async send(phone, code, purpose) {
    logger.warn("otp.code_logged_not_sent", { phoneTail: phone.slice(-4), purpose, code });
  },
};

let override: OtpProvider | null = null;
/** Tests install a capturing provider; production code never calls this. */
export function setOtpProviderForTests(provider: OtpProvider | null) {
  override = provider;
}

function provider(): OtpProvider | null {
  if (override) return override;
  const chosen = process.env.CODIQ_OTP_PROVIDER;
  if (chosen === "insecure-log") return logProvider;
  // Local development only (NODE_ENV unset or "development"); every deployed environment sets NODE_ENV.
  if (!chosen && (process.env.NODE_ENV ?? "development") === "development") return logProvider;
  return null;
}

function hashCode(challengeId: string, code: string, key: Buffer) {
  // The challenge id is in the MAC: the same six digits for two challenges hash differently.
  return crypto.createHmac("sha256", key).update(`${challengeId}:${code}`).digest("hex");
}

function sameHash(stored: string, candidate: string) {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function issueOtp(input: { phone: string; purpose: OtpPurpose; shopperId: string | null; ip: string }) {
  const sender = provider();
  if (!sender) throw new HttpError(503, "OTP_PROVIDER_NOT_CONFIGURED", "إرسال رمز التحقق غير مفعّل بعد. حاول لاحقاً.");
  await consumeStorefrontRateLimit({ scope: "market_otp_ip", rawKey: input.ip, limit: 20, windowMs: 60 * 60 * 1000 });
  await consumeStorefrontRateLimit({ scope: "market_otp_phone", rawKey: input.phone, limit: 5, windowMs: 60 * 60 * 1000 });
  const last = await prisma.shopperOtpChallenge.findFirst({ where: { phoneNormalized: input.phone, purpose: input.purpose }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_AFTER_MS) {
    const wait = Math.ceil((OTP_RESEND_AFTER_MS - (Date.now() - last.createdAt.getTime())) / 1000);
    throw new HttpError(429, "OTP_TOO_SOON", `انتظر ${wait} ثانية قبل طلب رمز جديد.`, { retryAfterSeconds: wait });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await prisma.shopperOtpChallenge.create({ data: { id, phoneNormalized: input.phone, purpose: input.purpose, shopperId: input.shopperId, codeHash: hashCode(id, code, OTP_KEYS.signing), expiresAt } });
  try {
    await sender.send(input.phone, code, input.purpose);
  } catch (error) {
    logger.error("otp.delivery_failed", { provider: sender.name, purpose: input.purpose, err: error });
    throw new HttpError(502, "OTP_DELIVERY_FAILED", "تعذّر إرسال رمز التحقق، حاول مرة أخرى.");
  }
  return { challengeId: id, expiresAt, resendAfterSeconds: OTP_RESEND_AFTER_MS / 1000 };
}

/**
 * Spends one try. Returns the verified phone, or throws: wrong code (with tries
 * left), expired, used, or out of tries — each a different code a screen can
 * word, none of which says whether the phone has an account.
 */
export async function consumeOtp(input: { challengeId: string; code: string; purpose: OtpPurpose; shopperId: string | null }): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(input.challengeId)) throw new HttpError(422, "OTP_INVALID", "رمز التحقق غير صحيح.");
  // The try is spent first, atomically, and only while tries remain.
  const spent = await prisma.$queryRaw<Array<{ phone_normalized: string; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null; purpose: string; shopper_id: string | null }>>`
    UPDATE shopper_otp_challenges SET attempts = attempts + 1
     WHERE id = ${input.challengeId}::uuid AND attempts < ${OTP_MAX_ATTEMPTS} AND consumed_at IS NULL
     RETURNING phone_normalized, code_hash, attempts, expires_at, consumed_at, purpose, shopper_id`;
  const row = spent[0];
  if (!row) throw new HttpError(429, "OTP_EXHAUSTED", "انتهت محاولات هذا الرمز. اطلب رمزاً جديداً.");
  if (row.purpose !== input.purpose || row.shopper_id !== input.shopperId) throw new HttpError(422, "OTP_INVALID", "رمز التحقق غير صحيح.");
  if (row.expires_at.getTime() <= Date.now()) throw new HttpError(422, "OTP_EXPIRED", "انتهت صلاحية الرمز. اطلب رمزاً جديداً.");
  const matches = OTP_KEYS.verifying.some((key) => sameHash(row.code_hash, hashCode(input.challengeId, input.code, key)));
  if (!matches) {
    const left = OTP_MAX_ATTEMPTS - row.attempts;
    throw new HttpError(422, "OTP_INVALID", left > 0 ? `رمز التحقق غير صحيح. باقي ${left} محاولات.` : "رمز التحقق غير صحيح. اطلب رمزاً جديداً.", { attemptsLeft: left });
  }
  const consumed = await prisma.shopperOtpChallenge.updateMany({ where: { id: input.challengeId, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new HttpError(422, "OTP_INVALID", "استُخدم هذا الرمز من قبل.");
  return row.phone_normalized;
}
