/**
 * Marketplace M13b — the partner app (a wallet).
 *
 * A2 · SIGN-IN FROM THE PARTNER. The partner opens the market with a token it
 * SIGNED (HMAC-SHA256 with the shared secret): its account id, the phone it
 * verified, a nonce, the time. Two minutes to use it, once. The first time the
 * partner account is linked to the market shopper with that phone (created if
 * new — the partner verified the number); afterwards the link alone signs him
 * in, and a token whose phone no longer matches the linked shopper is refused
 * until he signs in with his code again (re-authentication). Each entry is a
 * sync: «آخر مزامنة», and an empty name is taken from the partner.
 *
 * F10 · PAYMENT LINKS. A linked shopper asks for a link to pay one store's
 * part of his cart in the partner app. The link is a random token (only its
 * hash is kept), valid once, for 15 minutes, for that shopper, that cart and
 * that amount. When the partner reports — signed — that it took the money, the
 * cart must be exactly what it was (same lines, same quantities, same prices)
 * and in stock; otherwise the link is refused and the partner told to return
 * the money. A used, refused or expired link never pays twice.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { createTypedSession, normalizeIraqiMobile } from "../../auth/identity.js";
import { logger } from "../../logging/logger.js";
import { shopperView } from "../market-account/account.service.js";
import { listedStoreTenant } from "../market-stores/directory.service.js";
import { marketCartView } from "../market-cart/cart.service.js";
import { checkoutSummary, placeMarketOrder } from "../market-cart/checkout.service.js";
import { transitionOrderStatus } from "../../services/order-lifecycle.service.js";

const HANDOFF_MAX_AGE_S = 120;
const CLOCK_SKEW_S = 30;
export const LINK_TTL_MS = 15 * 60 * 1000;

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
function requirePartner() {
  const config = partnerConfig();
  if (!config) throw new HttpError(404, "PARTNER_OFF", "التطبيق الشريك غير مربوط.");
  return config;
}

function signatureOk(secret: string, payload: string | Buffer, signature: string | undefined) {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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

// ── F10: payment links ───────────────────────────────────────────────────────

/** What the cart is: lines, quantities, prices, the address and the way it is received. */
async function cartFingerprint(
  shopperId: string,
  storeId: string,
  addressId: string,
  fulfilment: string
) {
  const view = await marketCartView(shopperId, storeId);
  const group = view.stores[0];
  if (!group?.lines.length) return null;
  type Line = {
    variant: { id: string };
    quantity: number;
    livePriceIqd: number;
    addons: { id: string }[];
  };
  const lines = (group.lines as Line[])
    .map((line) =>
      [
        line.variant.id,
        line.quantity,
        line.livePriceIqd,
        line.addons
          .map((addon: { id: string }) => addon.id)
          .sort()
          .join("+"),
      ].join(":")
    )
    .sort();
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ lines, addressId, fulfilment }))
      .digest("hex"),
    ready: group.ready,
  };
}

type Shopper = { id: string; phoneNormalized: string; fullName: string | null };

export async function createPaymentLink(
  shopper: Shopper,
  storeSlug: string,
  input: { addressId: string; fulfilment: "delivery" | "pickup" }
) {
  const config = requirePartner();
  const link = await prisma.shopperPartnerLink.findUnique({
    where: { shopperId_partner: { shopperId: shopper.id, partner: config.id } },
  });
  if (!link)
    throw new HttpError(
      422,
      "PARTNER_NOT_LINKED",
      `اربط حسابك بـ${config.name} أوّلاً — ادخل السوق من داخل التطبيق.`
    );
  const store = await listedStoreTenant(storeSlug);
  const summary = await checkoutSummary(shopper, storeSlug, {
    addressId: input.addressId,
    fulfilment: input.fulfilment,
  });
  if (!summary.ready || !summary.delivery.available)
    throw new HttpError(422, "CART_NOT_READY", summary.delivery.reason ?? "راجع سلّتك قبل الدفع.");
  const cart = await cartFingerprint(shopper.id, store.id, input.addressId, input.fulfilment);
  if (!cart) throw new HttpError(422, "CART_EMPTY", "لا توجد منتجات من هذا المتجر في سلتك.");
  // One live link per shopper and store: a new one replaces the old.
  await prisma.checkoutToken.updateMany({
    where: { shopperId: shopper.id, storeId: store.id, status: "issued" },
    data: { status: "replaced" },
  });
  const token = randomBytes(32).toString("base64url");
  const row = await prisma.checkoutToken.create({
    data: {
      tokenHash: hashToken(token),
      shopperId: shopper.id,
      storeId: store.id,
      partner: config.id,
      addressId: input.addressId,
      fulfilment: input.fulfilment,
      cartFingerprint: cart.fingerprint,
      amountIqd: summary.totalIqd,
      expiresAt: new Date(Date.now() + LINK_TTL_MS),
    },
  });
  return {
    linkId: row.id,
    partner: config.name,
    amountIqd: summary.totalIqd,
    expiresAt: row.expiresAt,
    deepLink: `${config.payUrl}?token=${encodeURIComponent(token)}&amount=${summary.totalIqd}`,
  };
}

export async function paymentLinkStatus(shopperId: string, linkId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(linkId))
    throw new HttpError(404, "PAYMENT_LINK_NOT_FOUND", "رابط الدفع غير موجود.");
  const row = await prisma.checkoutToken.findFirst({
    where: { id: linkId, shopperId },
    select: {
      id: true,
      status: true,
      refusal: true,
      amountIqd: true,
      expiresAt: true,
      orderId: true,
    },
  });
  if (!row) throw new HttpError(404, "PAYMENT_LINK_NOT_FOUND", "رابط الدفع غير موجود.");
  if (row.status === "issued" && row.expiresAt < new Date()) {
    await prisma.checkoutToken.updateMany({
      where: { id: row.id, status: "issued" },
      data: { status: "expired" },
    });
    return { link: { ...row, status: "expired" } };
  }
  return { link: row };
}

/**
 * The partner's signed report that it took the money for a link. Answers
 * `{ ok: true, orderId }` or `{ ok: false, refund: true, reason }` — in the
 * second case the partner must give the money back; nothing was placed.
 */
export async function completePaymentLink(rawBody: Buffer, signature: string | undefined) {
  const config = requirePartner();
  if (!signatureOk(config.secret, rawBody, signature)) {
    logger.warn("security.refused", { reason: "partner_payment_signature" });
    throw new HttpError(401, "PARTNER_SIGNATURE_INVALID", "توقيع الطلب غير صحيح.");
  }
  let body: {
    token?: unknown;
    partnerAccountId?: unknown;
    amountIqd?: unknown;
    paymentRef?: unknown;
  };
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new HttpError(400, "PARTNER_BODY_INVALID", "جسم الطلب غير صالح.");
  }
  if (
    typeof body.token !== "string" ||
    typeof body.partnerAccountId !== "string" ||
    !Number.isInteger(body.amountIqd) ||
    typeof body.paymentRef !== "string" ||
    body.paymentRef.length > 120
  ) {
    throw new HttpError(422, "PARTNER_BODY_INVALID", "جسم الطلب ناقص.");
  }
  const row = await prisma.checkoutToken.findUnique({
    where: { tokenHash: hashToken(body.token) },
    include: { shopper: true, store: { select: { slug: true } } },
  });
  if (!row || row.partner !== config.id) return { ok: false, refund: true, reason: "LINK_UNKNOWN" };
  if (row.status === "used")
    return { ok: false, refund: true, reason: "LINK_USED", orderId: row.orderId };
  // Review 2026-11-21: a report already being handled (or one interrupted by a crash) is not
  // «used» — the partner must not take it for paid. Retry later; long after the link's life it is refused.
  if (row.status === "using") {
    if (row.expiresAt.getTime() + 5 * 60 * 1000 > Date.now())
      return { ok: false, refund: false, retryLater: true, reason: "LINK_IN_PROGRESS" };
    await prisma.checkoutToken.updateMany({
      where: { id: row.id, status: "using" },
      data: { status: "refused", refusal: "INTERRUPTED" },
    });
    return { ok: false, refund: true, reason: "INTERRUPTED" };
  }
  if (row.status !== "issued")
    return { ok: false, refund: true, reason: `LINK_${row.status.toUpperCase()}` };
  const refuse = async (reason: string) => {
    await prisma.checkoutToken.updateMany({
      where: { id: row.id, status: { in: ["issued", "using"] } },
      data: { status: "refused", refusal: reason },
    });
    return { ok: false, refund: true, reason };
  };
  // Single use, even against two reports at once: only one claims it.
  const claimed = await prisma.checkoutToken.updateMany({
    where: { id: row.id, status: "issued" },
    data: { status: "using" },
  });
  if (claimed.count !== 1)
    return { ok: false, refund: false, retryLater: true, reason: "LINK_IN_PROGRESS" };
  if (row.expiresAt < new Date()) return refuse("LINK_EXPIRED");
  const link = await prisma.shopperPartnerLink.findUnique({
    where: { shopperId_partner: { shopperId: row.shopperId, partner: config.id } },
  });
  if (!link || link.partnerAccountId !== body.partnerAccountId) return refuse("ACCOUNT_MISMATCH");
  if (body.amountIqd !== row.amountIqd) return refuse("AMOUNT_MISMATCH");
  const cart = await cartFingerprint(row.shopperId, row.storeId, row.addressId, row.fulfilment);
  if (!cart || cart.fingerprint !== row.cartFingerprint) return refuse("CART_CHANGED");
  if (!cart.ready) return refuse("OUT_OF_STOCK");
  try {
    const placed = await placeMarketOrder(
      {
        id: row.shopper.id,
        phoneNormalized: row.shopper.phoneNormalized,
        fullName: row.shopper.fullName,
      },
      row.store.slug,
      {
        addressId: row.addressId,
        fulfilment: row.fulfilment as "delivery" | "pickup",
        paymentMethodCode: "market_partner",
      },
      `partner-link-${row.id}`,
      { paidByPartner: true }
    );
    if (placed.order.totalIqd !== row.amountIqd) {
      // The prices moved under the lock: the order stands cancelled and the partner returns the money.
      logger.warn("payments.partner_amount_drift", { linkId: row.id });
      await transitionOrderStatus(
        placed.order.storeId ?? row.storeId,
        { kind: "system", id: row.id },
        placed.order.id,
        {
          toStatus: "cancelled",
          expectedVersion: placed.order.version,
          note: "تغيّر المبلغ عند الدفع من التطبيق الشريك.",
        }
      ).catch(() => undefined);
      return refuse("AMOUNT_MISMATCH");
    }
    await prisma.$transaction([
      prisma.checkoutToken.update({
        where: { id: row.id },
        data: { status: "used", usedAt: new Date(), orderId: placed.order.id },
      }),
      prisma.marketPayment.create({
        data: {
          shopperId: row.shopperId,
          storeId: row.storeId,
          orderId: placed.order.id,
          method: "partner",
          provider: config.id,
          providerRef: body.paymentRef,
          status: "paid",
          amountIqd: row.amountIqd,
          paidAt: new Date(),
          expiresAt: new Date(),
        },
      }),
    ]);
    return { ok: true, orderId: placed.order.id, orderNumber: placed.order.orderNumber };
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "CHECKOUT_FAILED";
    if (!(error instanceof HttpError))
      logger.warn("payments.partner_checkout_failed", {
        linkId: row.id,
        reason: (error as Error).message,
      });
    return refuse(code);
  }
}
