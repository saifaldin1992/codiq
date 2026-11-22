/**
 * The partner app — sign-in. Split verbatim from partner.service.ts (review batch 2, ت-٩);
 * partner.service.ts re-exports what it always exported.
 */
import { logger } from "../../../logging/logger.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { normalizeIraqiMobile, createTypedSession } from "../../../auth/identity.js";
import { prisma } from "../../../db/prisma.js";
import { shopperView } from "../../market-account/account.service.js";
import { signatureOk, requirePartner, partnerConfig } from "./config.js";

const HANDOFF_MAX_AGE_S = 120;

const CLOCK_SKEW_S = 30;

// ── A2: entering from the partner ───────────────────────────────────────────

type Handoff = {
  v: 1;
  partnerAccountId: string;
  phone: string;
  name?: string;
  iat: number;
  nonce: string;
};

function readHandoff(token: string, secret: string): Handoff {
  const [body, signature] = token.split(".");
  if (!body || !signatureOk(secret, body, signature)) {
    logger.warn("security.refused", { reason: "partner_handoff_signature" });
    throw new HttpError(
      401,
      "PARTNER_TOKEN_INVALID",
      "رابط الدخول غير صالح — افتح السوق من التطبيق مجدداً."
    );
  }
  let handoff: Handoff;
  try {
    handoff = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(401, "PARTNER_TOKEN_INVALID", "رابط الدخول غير صالح.");
  }
  if (
    handoff?.v !== 1 ||
    typeof handoff.partnerAccountId !== "string" ||
    !handoff.partnerAccountId ||
    handoff.partnerAccountId.length > 120 ||
    typeof handoff.phone !== "string" ||
    typeof handoff.nonce !== "string" ||
    handoff.nonce.length < 16 ||
    handoff.nonce.length > 80 ||
    !Number.isInteger(handoff.iat)
  ) {
    throw new HttpError(401, "PARTNER_TOKEN_INVALID", "رابط الدخول غير صالح.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (handoff.iat > now + CLOCK_SKEW_S || now - handoff.iat > HANDOFF_MAX_AGE_S)
    throw new HttpError(
      401,
      "PARTNER_TOKEN_EXPIRED",
      "انتهت صلاحيّة رابط الدخول — افتح السوق من التطبيق مجدداً."
    );
  return handoff;
}

/** The partner's signed handoff → a market session for the linked (or newly linked) shopper. */
export async function enterFromPartner(token: string) {
  const config = requirePartner();
  const handoff = readHandoff(token, config.secret);
  const phone = normalizeIraqiMobile(handoff.phone);
  if (!phone) throw new HttpError(422, "PARTNER_PHONE_INVALID", "رقم الهاتف من التطبيق غير صالح.");
  // Once: a replayed link is refused even inside its two minutes.
  try {
    await prisma.partnerHandoffNonce.create({ data: { partner: config.id, nonce: handoff.nonce } });
  } catch {
    logger.warn("security.refused", { reason: "partner_handoff_replay" });
    throw new HttpError(
      401,
      "PARTNER_TOKEN_USED",
      "استُعمل رابط الدخول هذا من قبل — افتح السوق من التطبيق مجدداً."
    );
  }
  void prisma.partnerHandoffNonce
    .deleteMany({ where: { usedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
    .catch(() => undefined);

  const existing = await prisma.shopperPartnerLink.findUnique({
    where: {
      partner_partnerAccountId: { partner: config.id, partnerAccountId: handoff.partnerAccountId },
    },
    include: { shopper: true },
  });
  let shopperId: string;
  if (existing) {
    // Re-authentication: the partner now says another phone. Not his account any more until he proves it.
    if (existing.shopper.phoneNormalized !== phone)
      throw new HttpError(
        409,
        "PARTNER_PHONE_MISMATCH",
        "رقم هاتفك في التطبيق تغيّر — ادخل السوق برمز يصل إلى رقمك ثمّ اربط الحساب من جديد."
      );
    shopperId = existing.shopperId;
  } else {
    const shopper = await prisma.shopper.upsert({
      where: { phoneNormalized: phone },
      update: {},
      create: {
        phoneNormalized: phone,
        ...(handoff.name ? { fullName: handoff.name.slice(0, 80) } : {}),
      },
    });
    const otherLink = await prisma.shopperPartnerLink.findUnique({
      where: { shopperId_partner: { shopperId: shopper.id, partner: config.id } },
    });
    if (otherLink)
      throw new HttpError(
        409,
        "PARTNER_ALREADY_LINKED",
        "حسابك في السوق مربوط بحساب آخر في التطبيق."
      );
    await prisma.shopperPartnerLink.create({
      data: {
        shopperId: shopper.id,
        partner: config.id,
        partnerAccountId: handoff.partnerAccountId,
      },
    });
    shopperId = shopper.id;
  }
  const current = await prisma.shopper.findUniqueOrThrow({ where: { id: shopperId } });
  if (!current.isActive)
    throw new HttpError(403, "SHOPPER_DISABLED", "هذا الحساب موقوف. تواصل مع الدعم.");
  const synced = await prisma.shopper.update({
    where: { id: shopperId },
    data: {
      lastLoginAt: new Date(),
      ...(!current.fullName && handoff.name ? { fullName: handoff.name.slice(0, 80) } : {}),
    },
  });
  await prisma.shopperPartnerLink.update({
    where: { shopperId_partner: { shopperId, partner: config.id } },
    data: { lastSyncedAt: new Date() },
  });
  return {
    token: await createTypedSession("shopper", shopperId),
    shopper: shopperView(synced),
    linkedNow: !existing,
  };
}

export async function partnerLinkOf(shopperId: string) {
  const config = partnerConfig();
  if (!config) return { partner: null };
  const link = await prisma.shopperPartnerLink.findUnique({
    where: { shopperId_partner: { shopperId, partner: config.id } },
    select: { linkedAt: true, lastSyncedAt: true },
  });
  return {
    partner: {
      name: config.name,
      linked: Boolean(link),
      linkedAt: link?.linkedAt ?? null,
      lastSyncedAt: link?.lastSyncedAt ?? null,
    },
  };
}

export async function unlinkPartner(shopperId: string) {
  const config = requirePartner();
  await prisma.shopperPartnerLink.deleteMany({ where: { shopperId, partner: config.id } });
  await prisma.checkoutToken.updateMany({
    where: { shopperId, partner: config.id, status: "issued" },
    data: { status: "replaced" },
  });
  return partnerLinkOf(shopperId);
}
