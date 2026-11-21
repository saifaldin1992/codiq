/**
 * Marketplace M13a — the ONE shape every payment provider takes.
 *
 *   CardGateway       a hosted payment page and a signed notification back.
 *   InstalmentLender  an account check (capacity, terms), a plan the shopper
 *                     confirms with a code the lender sends him, and changes
 *                     to the plan when the order is cancelled or returned.
 *
 * The rest of the platform talks to these interfaces only. Today they are
 * answered by TEST providers (`CODIQ_PAYMENTS_PROVIDER=fake`) that behave like
 * the real ones — signatures, codes, refusals, capacity — so the whole flow is
 * built and tested before a contract exists. A real provider is one more
 * adapter beside them, chosen by the same variable.
 *
 * Unset, no online method is offered and the market pays in cash, as before.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { logger } from "../../logging/logger.js";

export type CardSession = { providerRef: string; redirectUrl: string };
export type CardNotification = {
  eventId: string;
  type: "payment.succeeded" | "payment.failed";
  providerRef: string;
  amountIqd: number;
};

export interface CardGateway {
  id: string;
  name: string;
  createSession(input: {
    paymentId: string;
    amountIqd: number;
    description: string;
  }): Promise<CardSession>;
  /** The notification's body, if its signature is the provider's; null otherwise. */
  verifyNotification(rawBody: Buffer, signature: string | undefined): CardNotification | null;
  refund(input: { providerRef: string; amountIqd: number }): Promise<{ refundRef: string }>;
}

export type LenderTerm = { months: number; feePercent: number };
export type LenderAccount = { hasAccount: boolean; capacityIqd: number; reason: string | null };

export interface InstalmentLender {
  id: string;
  name: string;
  terms: LenderTerm[];
  minimumIqd: number;
  /** The fewest months this lender allows for an amount (bigger amounts, longer plans). */
  minMonths(amountIqd: number): number;
  account(phoneE164: string): Promise<LenderAccount>;
  /** Opens a plan and sends the shopper a code. */
  startPlan(input: {
    phoneE164: string;
    amountIqd: number;
    months: number;
    reference: string;
  }): Promise<{ planRef: string }>;
  confirmPlan(input: { planRef: string; code: string }): Promise<boolean>;
  cancelPlan(input: { planRef: string }): Promise<void>;
  /** After a return: the plan now covers `amountIqd` (0 closes it). */
  adjustPlan(input: { planRef: string; amountIqd: number }): Promise<void>;
}

export function monthlyFor(amountIqd: number, term: LenderTerm, cashPrice: boolean) {
  const feeIqd = cashPrice ? 0 : Math.ceil((amountIqd * term.feePercent) / 100);
  const totalIqd = amountIqd + feeIqd;
  return { months: term.months, feeIqd, totalIqd, monthlyIqd: Math.ceil(totalIqd / term.months) };
}

// ── the test providers ───────────────────────────────────────────────────────

function secret() {
  const value = process.env.CODIQ_PAYMENTS_WEBHOOK_SECRET?.trim();
  if (!value || value.length < 32)
    throw new Error(
      "CODIQ_PAYMENTS_WEBHOOK_SECRET must be at least 32 characters when online payments are on."
    );
  return value;
}

export function signNotification(rawBody: Buffer | string) {
  return createHmac("sha256", secret()).update(rawBody).digest("hex");
}

const fakeCard: CardGateway = {
  id: "fake-card",
  name: "بطاقة (مزوّد تجريبيّ)",
  async createSession(input) {
    // The «hosted page» of the test provider is a page of this app that plays the provider's part.
    return {
      providerRef: `fc_${randomBytes(12).toString("hex")}`,
      redirectUrl: `/market/pay/${input.paymentId}`,
    };
  },
  verifyNotification(rawBody, signature) {
    if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return null;
    const expected = Buffer.from(signNotification(rawBody), "hex");
    const given = Buffer.from(signature, "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const body = JSON.parse(rawBody.toString("utf8"));
      if (
        typeof body?.eventId !== "string" ||
        typeof body?.providerRef !== "string" ||
        !Number.isInteger(body?.amountIqd)
      )
        return null;
      if (body.type !== "payment.succeeded" && body.type !== "payment.failed") return null;
      return {
        eventId: body.eventId,
        type: body.type,
        providerRef: body.providerRef,
        amountIqd: body.amountIqd,
      };
    } catch {
      return null;
    }
  },
  async refund() {
    return { refundRef: `fr_${randomBytes(8).toString("hex")}` };
  },
};

/** The code a test lender «sends»: derived from the plan, logged like the market's OTP in development. */
function fakeCode(planRef: string) {
  const digest = createHmac("sha256", secret()).update(`code:${planRef}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function fakeLender(config: {
  id: string;
  name: string;
  terms: LenderTerm[];
  minimumIqd: number;
  capacityIqd: number;
  longFrom: number;
  longMonths: number;
  noAccountDigit: string;
}): InstalmentLender {
  return {
    id: config.id,
    name: config.name,
    terms: config.terms,
    minimumIqd: config.minimumIqd,
    minMonths(amountIqd) {
      return amountIqd >= config.longFrom ? config.longMonths : config.terms[0]!.months;
    },
    // Deterministic test accounts, by the phone's last digit: one digit has no account here, 9 has a small capacity.
    async account(phone) {
      const last = phone.slice(-1);
      if (last === config.noAccountDigit)
        return {
          hasAccount: false,
          capacityIqd: 0,
          reason: "لا يوجد حساب لدى هذه الجهة بهذا الرقم.",
        };
      return {
        hasAccount: true,
        capacityIqd: last === "9" ? 100_000 : config.capacityIqd,
        reason: null,
      };
    },
    async startPlan(input) {
      const planRef = `${config.id}_${randomUUID()}`;
      logger.info("payments.fake_code_logged", {
        lender: config.id,
        code: fakeCode(planRef),
        reference: input.reference,
      });
      return { planRef };
    },
    async confirmPlan(input) {
      const expected = Buffer.from(fakeCode(input.planRef));
      const given = Buffer.from(String(input.code).padEnd(6).slice(0, 6));
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
    async cancelPlan() {
      /* the test lender just forgets it */
    },
    async adjustPlan() {
      /* the test lender just accepts it */
    },
  };
}

const fakeLenders: InstalmentLender[] = [
  fakeLender({
    id: "fake-instalments-a",
    name: "جهة التقسيط الأولى (تجريبيّة)",
    terms: [
      { months: 3, feePercent: 0 },
      { months: 6, feePercent: 4 },
      { months: 10, feePercent: 7 },
      { months: 12, feePercent: 9 },
    ],
    minimumIqd: 50_000,
    capacityIqd: 2_000_000,
    longFrom: 1_000_000,
    longMonths: 6,
    noAccountDigit: "0",
  }),
  fakeLender({
    id: "fake-instalments-b",
    name: "جهة التقسيط الثانية (تجريبيّة)",
    terms: [
      { months: 6, feePercent: 5 },
      { months: 12, feePercent: 10 },
      { months: 18, feePercent: 15 },
      { months: 24, feePercent: 20 },
    ],
    minimumIqd: 250_000,
    capacityIqd: 5_000_000,
    longFrom: 2_000_000,
    longMonths: 12,
    noAccountDigit: "1",
  }),
];

export function paymentsMode(): "off" | "fake" {
  return process.env.CODIQ_PAYMENTS_PROVIDER?.trim() === "fake" ? "fake" : "off";
}
export function cardGateway(): CardGateway | null {
  return paymentsMode() === "fake" ? fakeCard : null;
}
export function lenders(): InstalmentLender[] {
  return paymentsMode() === "fake" ? fakeLenders : [];
}
export function lender(id: string): InstalmentLender | null {
  return lenders().find((entry) => entry.id === id) ?? null;
}
export function fakeCodeForTests(planRef: string) {
  return fakeCode(planRef);
}
