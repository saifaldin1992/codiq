/**
 * Market payments — instalments. Split verbatim from payments.service.ts (review batch 2, ت-٨);
 * payments.service.ts re-exports what it always exported.
 */
import { randomUUID } from "node:crypto";
import { HttpError } from "../../../auth/auth.errors.js";
import { lender, type InstalmentLender } from "../providers.js";
import { prisma } from "../../../db/prisma.js";
import { type Shopper, event } from "./events.js";
import { onlineOptions } from "./options.js";

const PLAN_WINDOW_MS = 10 * 60 * 1000;

const MAX_CODE_ATTEMPTS = 5;

// ── instalments ──────────────────────────────────────────────────────────────

/** The shopper picked a lender and a term: open the plan and have the code sent. */
export async function startInstalmentPlan(
  shopper: Shopper,
  storeId: string,
  goodsIqd: number,
  input: { lender: string; months: number }
) {
  const options = await onlineOptions(shopper, storeId, goodsIqd);
  const offer = options.instalments?.lenders.find((entry) => entry.id === input.lender);
  if (!offer) throw new HttpError(422, "INSTALMENT_LENDER_UNKNOWN", "جهة التقسيط غير متاحة.");
  if (!offer.available)
    throw new HttpError(
      422,
      "INSTALMENT_NOT_ELIGIBLE",
      offer.reason ?? "التقسيط غير متاح لهذا الطلب."
    );
  const term = offer.terms.find((entry) => entry.months === input.months);
  if (!term)
    throw new HttpError(
      422,
      "INSTALMENT_TERM_INVALID",
      `اختر مدّة من ${offer.minMonths} أشهر أو أكثر من المدد المعروضة.`
    );
  const provider = lender(input.lender) as InstalmentLender;
  // One open plan per shopper and store: a new choice replaces the old one.
  await prisma.marketPayment.updateMany({
    where: { shopperId: shopper.id, storeId, method: "instalments", status: "code_sent" },
    data: { status: "cancelled" },
  });
  const id = randomUUID();
  const { planRef } = await provider.startPlan({
    phoneE164: shopper.phoneNormalized,
    amountIqd: goodsIqd,
    months: term.months,
    reference: id,
  });
  await prisma.marketPayment.create({
    data: {
      id,
      shopperId: shopper.id,
      storeId,
      method: "instalments",
      provider: provider.id,
      providerRef: planRef,
      status: "code_sent",
      amountIqd: goodsIqd,
      months: term.months,
      monthlyIqd: term.monthlyIqd,
      feeIqd: term.feeIqd,
      expiresAt: new Date(Date.now() + PLAN_WINDOW_MS),
    },
  });
  await event(id, "plan_started", {
    amountIqd: goodsIqd,
    detail: { months: term.months, monthlyIqd: term.monthlyIqd },
  });
  return {
    paymentId: id,
    lender: provider.name,
    months: term.months,
    monthlyIqd: term.monthlyIqd,
    feeIqd: term.feeIqd,
    totalIqd: term.totalIqd,
    sentTo: `•••${shopper.phoneNormalized.slice(-4)}`,
    expiresAt: new Date(Date.now() + PLAN_WINDOW_MS),
  };
}

/** Before the order: the code approves the plan. Five wrong codes close it. */
export async function confirmInstalmentPlan(
  shopper: Shopper,
  storeId: string,
  paymentId: unknown,
  code: unknown,
  goodsIqd: number
) {
  if (typeof paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(paymentId))
    throw new HttpError(422, "INSTALMENT_PLAN_REQUIRED", "اختر جهة التقسيط والمدّة أوّلاً.");
  const payment = await prisma.marketPayment.findFirst({
    where: { id: paymentId, shopperId: shopper.id, storeId, method: "instalments" },
  });
  if (!payment || payment.status !== "code_sent")
    throw new HttpError(422, "INSTALMENT_PLAN_REQUIRED", "اختر جهة التقسيط والمدّة من جديد.");
  if (payment.expiresAt < new Date()) {
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "expired" } });
    throw new HttpError(422, "INSTALMENT_PLAN_EXPIRED", "انتهت مهلة الرمز — اطلبه من جديد.");
  }
  if (payment.amountIqd !== goodsIqd) {
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    throw new HttpError(
      422,
      "INSTALMENT_AMOUNT_CHANGED",
      "تغيّر مبلغ الطلب منذ اخترت التقسيط — اختر المدّة من جديد."
    );
  }
  const provider = lender(payment.provider);
  if (!provider || !payment.providerRef)
    throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "جهة التقسيط غير متاحة الآن.");
  const attempts = await prisma.marketPayment.update({
    where: { id: payment.id },
    data: { codeAttempts: { increment: 1 } },
    select: { codeAttempts: true },
  });
  if (attempts.codeAttempts > MAX_CODE_ATTEMPTS) {
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    await provider.cancelPlan({ planRef: payment.providerRef });
    throw new HttpError(429, "INSTALMENT_CODE_LOCKED", "محاولات كثيرة — اطلب رمزاً جديداً.");
  }
  if (
    typeof code !== "string" ||
    !(await provider.confirmPlan({ planRef: payment.providerRef, code: code.trim() }))
  ) {
    await event(payment.id, "code_wrong");
    throw new HttpError(422, "INSTALMENT_CODE_WRONG", "الرمز غير صحيح.");
  }
  // Claimed HERE, not when the order attaches: two checkouts sent at once both passed the code
  // while the plan was still «code_sent», and two orders rode one plan — the second shipped
  // unpaid (review batch 2, ح-١). Only the request that claims it may place the order.
  const claimed = await prisma.marketPayment.updateMany({
    where: { id: payment.id, status: "code_sent" },
    data: { status: "approved", paidAt: new Date() },
  });
  if (claimed.count !== 1)
    throw new HttpError(422, "INSTALMENT_PLAN_REQUIRED", "اختر جهة التقسيط والمدّة من جديد.");
  return payment;
}

/** After the order exists: the approved plan belongs to it. */
export async function attachInstalmentPlan(paymentId: string, orderId: string) {
  await prisma.marketPayment.update({
    where: { id: paymentId },
    data: { orderId, status: "approved", paidAt: new Date() },
  });
  await event(paymentId, "plan_approved", { detail: { orderId } });
}

/** The order could not be placed after the code: the lender forgets the plan. */
export async function abandonInstalmentPlan(paymentId: string) {
  const payment = await prisma.marketPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.orderId) return;
  await prisma.marketPayment.update({
    where: { id: paymentId },
    data: { status: "cancelled", paidAt: null },
  });
  if (payment.providerRef)
    await lender(payment.provider)
      ?.cancelPlan({ planRef: payment.providerRef })
      .catch(() => undefined);
  await event(paymentId, "plan_abandoned");
}
