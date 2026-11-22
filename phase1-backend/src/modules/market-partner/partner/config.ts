/**
 * The partner app — config. Split verbatim from partner.service.ts (review batch 2, ت-٩);
 * partner.service.ts re-exports what it always exported.
 */
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { HttpError } from "../../../auth/auth.errors.js";

export function partnerConfig() {
  const secret = process.env.CODIQ_PARTNER_APP_SECRET?.trim() ?? "";
  if (secret.length < 32) return null;
  return {
    id: process.env.CODIQ_PARTNER_APP_ID?.trim() || "partner",
    name: process.env.CODIQ_PARTNER_APP_NAME?.trim() || "التطبيق الشريك",
    payUrl: process.env.CODIQ_PARTNER_APP_PAY_URL?.trim() || "codiq-partner://pay",
    secret,
  };
}

export function requirePartner() {
  const config = partnerConfig();
  if (!config) throw new HttpError(404, "PARTNER_OFF", "التطبيق الشريك غير مربوط.");
  return config;
}

export function signatureOk(
  secret: string,
  payload: string | Buffer,
  signature: string | undefined
) {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
