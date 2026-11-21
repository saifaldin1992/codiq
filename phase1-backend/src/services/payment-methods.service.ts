/**
 * ق-209 — payment methods the merchant switches on and off.
 *
 * ============================================================================
 * WHAT A SWITCH MAY HONESTLY MEAN TODAY
 * ============================================================================
 *
 * Cash on delivery needs nothing. An electronic GATEWAY (card, QiCard) needs
 * phase 25أ — until then its switch is shown, named, and cannot be turned on,
 * because a method the shopper picks and nobody can charge is a lie. What a
 * merchant may switch on now is a MANUAL WALLET TRANSFER (زين كاش، آسيا
 * حوالة، FIB): he names his wallet, the shopper picks it at checkout and sees
 * the number, transfers, and the order is created «بانتظار التحويل» until the
 * merchant confirms. That is how Iraqi shops take electronic money today.
 *
 * ============================================================================
 * TWO RULES
 * ============================================================================
 *
 *  1. A store can never be left with NO way to pay. The last enabled method
 *     refuses to switch off — a shop whose checkout says «لا توجد وسيلة دفع»
 *     is a shop the merchant will not notice is closed.
 *  2. Cash on delivery is ON until the merchant switches it off. No row means
 *     the phase-1 default, not «nothing»; every existing store keeps working
 *     exactly as before this landed.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";

export type PaymentMethodKind = "cod" | "manual_transfer" | "gateway";

export interface PaymentMethodDefinition {
  code: string;
  displayName: string;
  kind: PaymentMethodKind;
  /** May the merchant switch it on today? */
  available: boolean;
  unavailableReason?: string;
  hint: string;
}

export const PAYMENT_METHOD_CATALOG: readonly PaymentMethodDefinition[] = [
  { code: "cod", displayName: "الدفع عند الاستلام", kind: "cod", available: true, hint: "يدفع الزبون نقداً للمندوب عند التسليم." },
  { code: "zaincash", displayName: "زين كاش", kind: "manual_transfer", available: true, hint: "يحوّل الزبون المبلغ إلى محفظتك قبل التسليم، وتؤكد الدفع من صفحة الطلب." },
  { code: "asiahawala", displayName: "آسيا حوالة", kind: "manual_transfer", available: true, hint: "يحوّل الزبون المبلغ إلى محفظتك قبل التسليم، وتؤكد الدفع من صفحة الطلب." },
  { code: "fib", displayName: "FIB — المصرف العراقي الأول", kind: "manual_transfer", available: true, hint: "يحوّل الزبون المبلغ إلى حسابك قبل التسليم، وتؤكد الدفع من صفحة الطلب." },
  { code: "qicard", displayName: "كي كارد", kind: "gateway", available: false, unavailableReason: "بوابة الدفع تُربط في المرحلة 25أ.", hint: "" },
  { code: "card", displayName: "فيزا / ماستركارد", kind: "gateway", available: false, unavailableReason: "بوابة الدفع تُربط في المرحلة 25أ.", hint: "" },
];

/** What a manual transfer needs the shopper to know. */
export interface TransferConfiguration { walletNumber?: string; holderName?: string; instructions?: string }

export interface PaymentMethodView extends PaymentMethodDefinition {
  enabled: boolean;
  walletNumber: string | null;
  holderName: string | null;
  instructions: string | null;
}

const WALLET_NUMBER = /^[+0-9][0-9 -]{5,29}$/;

function definition(code: string): PaymentMethodDefinition {
  const found = PAYMENT_METHOD_CATALOG.find((entry) => entry.code === code);
  if (!found) throw new HttpError(404, "RESOURCE_NOT_FOUND", "وسيلة الدفع غير معروفة.");
  return found;
}

function configurationOf(row: { configuration: unknown } | null | undefined): TransferConfiguration {
  const raw = row?.configuration;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : undefined);
  return { walletNumber: text("walletNumber"), holderName: text("holderName"), instructions: text("instructions") };
}

type MethodRow = { code: string; isEnabled: boolean; configuration: unknown };

/** Rule 2: no row for COD means COD is on. */
function isEnabled(code: string, rows: readonly MethodRow[]): boolean {
  const row = rows.find((entry) => entry.code === code);
  return row ? row.isEnabled : code === "cod";
}

export async function listPaymentMethods(storeId: string): Promise<{ methods: PaymentMethodView[] }> {
  const rows = await prisma.paymentMethod.findMany({ where: { storeId }, select: { code: true, isEnabled: true, configuration: true } });
  return {
    methods: PAYMENT_METHOD_CATALOG.map((entry) => {
      const row = rows.find((candidate) => candidate.code === entry.code);
      const configuration = configurationOf(row);
      return { ...entry, enabled: isEnabled(entry.code, rows), walletNumber: configuration.walletNumber ?? null, holderName: configuration.holderName ?? null, instructions: configuration.instructions ?? null };
    }),
  };
}

export async function updatePaymentMethod(
  storeId: string,
  code: string,
  input: { isEnabled?: boolean; walletNumber?: string | null; holderName?: string | null; instructions?: string | null },
): Promise<{ methods: PaymentMethodView[] }> {
  const entry = definition(code);
  if (!entry.available) throw new HttpError(422, "PAYMENT_METHOD_UNAVAILABLE", entry.unavailableReason ?? "هذه الوسيلة غير متاحة بعد.");
  const rows = await prisma.paymentMethod.findMany({ where: { storeId }, select: { code: true, isEnabled: true, configuration: true } });
  const current = configurationOf(rows.find((row) => row.code === code));
  const clear = (value: string | null | undefined, previous: string | undefined) => (value === undefined ? previous : value === null || value.trim() === "" ? undefined : value.trim());
  const next: TransferConfiguration = {
    walletNumber: clear(input.walletNumber, current.walletNumber),
    holderName: clear(input.holderName, current.holderName),
    instructions: clear(input.instructions, current.instructions),
  };
  if (next.walletNumber !== undefined && !WALLET_NUMBER.test(next.walletNumber)) {
    throw new HttpError(422, "INVALID_WALLET_NUMBER", "رقم المحفظة أو الحساب يجب أن يكون أرقاماً (6–30 خانة).");
  }
  const enabled = input.isEnabled ?? isEnabled(code, rows);
  if (entry.kind === "manual_transfer" && enabled && !next.walletNumber) {
    throw new HttpError(422, "WALLET_NUMBER_REQUIRED", `اكتب رقم محفظتك على ${entry.displayName} قبل تفعيلها — الزبون يحتاجه ليحوّل.`);
  }
  // Rule 1: the last way to pay refuses to switch off.
  if (!enabled) {
    const othersOn = PAYMENT_METHOD_CATALOG.some((candidate) => candidate.code !== code && candidate.available && isEnabled(candidate.code, rows));
    if (!othersOn) throw new HttpError(422, "LAST_PAYMENT_METHOD", "لا يمكن إطفاء آخر وسيلة دفع — فعّل وسيلة أخرى أولاً.");
  }
  const configuration = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as Prisma.InputJsonObject;
  await prisma.paymentMethod.upsert({
    where: { storeId_code: { storeId, code } },
    update: { isEnabled: enabled, configuration },
    create: { storeId, code, displayName: entry.displayName, isEnabled: enabled, configuration },
  });
  return listPaymentMethods(storeId);
}

export interface EnabledPaymentMethod { code: string; displayName: string; kind: PaymentMethodKind; walletNumber?: string; holderName?: string; instructions?: string }

/** The methods a shopper may pick — what the storefront's payload and the checkout both read. */
export async function enabledPaymentMethods(client: Prisma.TransactionClient | typeof prisma, storeId: string): Promise<EnabledPaymentMethod[]> {
  const rows = await client.paymentMethod.findMany({ where: { storeId }, select: { code: true, isEnabled: true, configuration: true } });
  return PAYMENT_METHOD_CATALOG
    .filter((entry) => entry.available && isEnabled(entry.code, rows))
    .map((entry) => {
      const configuration = configurationOf(rows.find((row) => row.code === entry.code));
      return { code: entry.code, displayName: entry.displayName, kind: entry.kind, ...(entry.kind === "manual_transfer" ? configuration : {}) };
    });
}

/** At checkout: the method he picked, if the store takes it — `undefined` means cash, as it always has. */
/**
 * Marketplace M13a: the market's own online methods. Not a store's switch — the
 * platform collects them through its providers — so only the market's checkout
 * may name them (`market` below); a storefront request naming one is refused.
 */
export const MARKET_PAYMENT_METHODS = { market_card: { code: "market_card", displayName: "بطاقة إلكترونيّة", kind: "gateway" }, market_instalments: { code: "market_instalments", displayName: "أقساط", kind: "gateway" }, market_partner: { code: "market_partner", displayName: "التطبيق الشريك", kind: "gateway" } } as const;

export async function paymentMethodForCheckout(client: Prisma.TransactionClient | typeof prisma, storeId: string, rawCode: unknown, market?: "card" | "instalments" | "partner"): Promise<EnabledPaymentMethod> {
  const code = rawCode === undefined || rawCode === null || rawCode === "" ? "cod" : rawCode;
  if (typeof code !== "string") throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "وسيلة الدفع غير مدعومة.");
  if (code === "market_card" || code === "market_instalments" || code === "market_partner") {
    if (market !== code.slice("market_".length)) throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "وسيلة الدفع غير مدعومة.");
    return { ...MARKET_PAYMENT_METHODS[code] };
  }
  const method = (await enabledPaymentMethods(client, storeId)).find((entry) => entry.code === code);
  if (!method) throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "هذا المتجر لا يقبل وسيلة الدفع المختارة.");
  return method;
}
