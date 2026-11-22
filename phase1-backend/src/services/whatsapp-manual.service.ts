/**
 * WA-1 (ق-131/ق-139) — the manual WhatsApp channel.
 *
 * The owner's decision put WhatsApp BEFORE email in the channel order because
 * in Iraq WhatsApp IS the channel. No Business-API contract exists yet, so v1
 * is the honest form of the feature: the server renders an Arabic message for
 * one order and one occasion, hands the client a prefilled wa.me link, and the
 * MERCHANT'S OWN WhatsApp opens with the text ready. We record the tap as an
 * auditable act («who sent what, when») and never claim delivery — a wa.me
 * link cannot know whether the human pressed send.
 *
 * Load-bearing boundaries:
 *  - NEVER the notification outbox. The outbox models messages the system will
 *    deliver (claim/retry/provider); this models an act a person performed.
 *    Nothing here touches notification_outbox, its CHECKs, or
 *    notification_event_kinds — pg3 pins all three.
 *  - Phones go through `toE164` ONLY (identity.ts) — its null-not-throw
 *    contract is an anti-enumeration guarantee elsewhere and is not widened
 *    here. A local «07…» seed still yields a correct wa.me link; garbage
 *    yields an honest disabled state, computed server-side.
 *  - {{رابط_التتبع}} may only ever be the public two-secret tracking PAGE via
 *    `publicUrl`. When CODIQ_PUBLIC_BASE_URL is unset the whole line is
 *    dropped (the linkLine pattern) — no relative path ever ships.
 *  - The audit row stores what the SERVER rendered. The POST takes a
 *    templateKey only; a client-supplied body would make the audit worthless.
 */
import { HttpError } from "../auth/auth.errors.js";
import { toE164 } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import { publicUrl } from "../notifications/messaging-compliance.service.js";
import { collectsCashOnDelivery } from "./payment-methods.service.js";

export const WHATSAPP_TEMPLATE_KEYS = ["orderCreated", "courierDispatched", "orderCompleted"] as const;
export type WhatsappTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

/** camelCase in JSON/API ↔ snake_case in the DB CHECK, mapped here like the rest of the house. */
const TEMPLATE_DB_KEYS: Record<WhatsappTemplateKey, string> = {
  orderCreated: "order_created",
  courierDispatched: "courier_dispatched",
  orderCompleted: "order_completed",
};
const TEMPLATE_KEY_FROM_DB = Object.fromEntries(
  Object.entries(TEMPLATE_DB_KEYS).map(([camel, snake]) => [snake, camel]),
) as Record<string, WhatsappTemplateKey>;

export const WHATSAPP_TEMPLATE_LABELS: Record<WhatsappTemplateKey, string> = {
  orderCreated: "تأكيد استلام الطلب",
  courierDispatched: "المندوب في الطريق",
  orderCompleted: "شكر بعد التسليم",
};

/**
 * Masculine Arabic defaults (ق-96). `courierDispatched` mirrors the CD-1b
 * outbox wording so the customer reads ONE voice whichever channel reached him.
 */
const TEMPLATE_DEFAULTS: Record<WhatsappTemplateKey, string> = {
  orderCreated:
    "مرحباً {{اسم_الزبون}}، استلمنا طلبك {{رقم_الطلب}} من {{اسم_المتجر}} بمبلغ {{المبلغ}}. يرجى الرد بكلمة «تأكيد» لنباشر التجهيز.\n{{رابط_التتبع}}",
  courierDispatched:
    "خرج طلبك {{رقم_الطلب}} من {{اسم_المتجر}} مع مندوب التوصيل وهو الآن في طريقه إليك. {{تعليمات_الدفع}}\n{{رابط_التتبع}}",
  orderCompleted:
    "شكراً لك {{اسم_الزبون}}! تم تسليم طلبك {{رقم_الطلب}} من {{اسم_المتجر}}. يسعدنا خدمتك مجدداً.",
};

/** The five variables a template may use — anything else in a saved template is a 422. */
const TEMPLATE_VARIABLES = ["اسم_الزبون", "رقم_الطلب", "اسم_المتجر", "المبلغ", "رابط_التتبع", "تعليمات_الدفع"] as const;

export const WHATSAPP_TEMPLATE_MAX_LENGTH = 1000;

const money = new Intl.NumberFormat("ar-IQ", { maximumFractionDigits: 0 });

/** Tolerant read with code defaults — the courierDispatch idiom. */
export function normalizeWhatsappTemplates(configuration: unknown): Record<WhatsappTemplateKey, string> {
  const block =
    configuration && typeof configuration === "object" && !Array.isArray(configuration)
      ? (configuration as Record<string, unknown>).whatsappTemplates
      : undefined;
  const stored =
    block && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>) : {};
  const templates = {} as Record<WhatsappTemplateKey, string>;
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    const value = stored[key];
    templates[key] = typeof value === "string" && value.trim() ? value : TEMPLATE_DEFAULTS[key];
  }
  return templates;
}

/**
 * Validates the PUT body's `whatsappTemplates` block: allow-listed keys, string
 * values, length cap, and the {{token}} allow-list. Returns the block to store —
 * an empty/whitespace string DELETES the key (revert to the code default).
 */
export function validateWhatsappTemplatesInput(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(422, "INVALID_INPUT", "قوالب واتساب غير صالحة.");
  }
  const entries = raw as Record<string, unknown>;
  const stored: Record<string, string> = {};
  for (const key of Object.keys(entries)) {
    if (!WHATSAPP_TEMPLATE_KEYS.includes(key as WhatsappTemplateKey)) {
      throw new HttpError(422, "INVALID_INPUT", `قالب واتساب غير معروف: ${key}`);
    }
    const value = entries[key];
    if (typeof value !== "string") throw new HttpError(422, "INVALID_INPUT", `${key} must be a string.`);
    const trimmed = value.trim();
    if (!trimmed) continue; // revert-to-default
    if (trimmed.length > WHATSAPP_TEMPLATE_MAX_LENGTH) {
      throw new HttpError(422, "INVALID_INPUT", `قالب واتساب يجب ألا يتجاوز ${WHATSAPP_TEMPLATE_MAX_LENGTH} حرف.`);
    }
    const tokenPattern = /\{\{([^{}]*)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(trimmed)) !== null) {
      const token = (match[1] ?? "").trim();
      if (!TEMPLATE_VARIABLES.includes(token as (typeof TEMPLATE_VARIABLES)[number])) {
        throw new HttpError(422, "INVALID_INPUT", `متغيّر غير معروف في القالب: {{${token}}}`);
      }
    }
    stored[key] = trimmed;
  }
  return stored;
}

type RenderContext = {
  customerName: string;
  orderNumber: string;
  storeName: string;
  storeSlug: string;
  totalIqd: number;
  /** Cash on delivery? A prepaid shopper is told he owes the courier nothing. */
  cashAtDoor: boolean;
};

/**
 * Allow-listed substitution. The tracking link is `publicUrl` of the CD-1a
 * two-secret page — and when no public base URL is configured, the WHOLE line
 * holding the token is dropped rather than shipping a relative path.
 */
export function renderWhatsappTemplate(template: string, context: RenderContext): string {
  const trackingUrl = publicUrl(`/store/${encodeURIComponent(context.storeSlug)}/track`);
  const substitutions: Record<string, string> = {
    "اسم_الزبون": context.customerName,
    "رقم_الطلب": context.orderNumber,
    "اسم_المتجر": context.storeName,
    "المبلغ": `${money.format(context.totalIqd)} د.ع`,
    "رابط_التتبع": trackingUrl ?? "",
    "تعليمات_الدفع": context.cashAtDoor
      ? `يرجى تجهيز مبلغ الدفع عند الاستلام: ${money.format(context.totalIqd)} د.ع.`
      : "طلبك مدفوع مسبقاً — لا تدفع شيئاً للمندوب.",
  };
  const lines = template.split("\n").flatMap((line) => {
    if (!trackingUrl && line.includes("{{رابط_التتبع}}")) return [];
    return [line.replace(/\{\{([^{}]*)\}\}/g, (whole, name: string) => substitutions[name.trim()] ?? whole)];
  });
  return lines.join("\n").trim();
}

function waUrlFor(e164: string, body: string): string {
  return `https://wa.me/${e164.slice(1)}?text=${encodeURIComponent(body)}`;
}

async function scopedOrder(storeId: string, orderId: string) {
  // findFirst on the (id, storeId) pair: a foreign order is indistinguishable
  // from a missing one (the order-notes idiom).
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId },
    select: { id: true, orderNumber: true, customerName: true, recipientPhone: true, totalIqd: true, status: true, paymentMethodCode: true },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود في هذا المتجر.");
  return order;
}

async function storeContext(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { name: true, slug: true } });
  if (!store) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المتجر غير موجود.");
  return store;
}

/** One batched name read per kind — the withAuthorNames idiom from order notes. */
async function withActorNames(
  sends: Array<{ id: string; templateKey: string; actorKind: string; actorId: string; createdAt: Date }>,
) {
  const merchantIds = Array.from(new Set(sends.filter((s) => s.actorKind === "merchant").map((s) => s.actorId)));
  const staffIds = Array.from(new Set(sends.filter((s) => s.actorKind === "staff").map((s) => s.actorId)));
  const [merchants, staff] = await Promise.all([
    merchantIds.length
      ? prisma.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id: true, businessName: true } })
      : Promise.resolve([]),
    staffIds.length
      ? prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, displayName: true } })
      : Promise.resolve([]),
  ]);
  const names = new Map<string, string>();
  for (const merchant of merchants) names.set(merchant.id, merchant.businessName);
  for (const member of staff) names.set(member.id, member.displayName);
  return sends.map((send) => ({
    id: send.id,
    templateKey: TEMPLATE_KEY_FROM_DB[send.templateKey] ?? send.templateKey,
    actorKind: send.actorKind,
    actorName: names.get(send.actorId) ?? null,
    createdAt: send.createdAt,
  }));
}

/**
 * The panel for one order: templates rendered from live order data, the wa.me
 * links ready-made (the client parses NOTHING), the readiness verdict, and the
 * recent audit trail.
 */
export async function whatsappPanelForOrder(storeId: string, orderId: string) {
  const [order, store] = await Promise.all([scopedOrder(storeId, orderId), storeContext(storeId)]);
  const settings = await prisma.notificationSettings.findUnique({ where: { storeId }, select: { configuration: true } });
  const templates = normalizeWhatsappTemplates(settings?.configuration);
  const e164 = toE164(order.recipientPhone);
  const reason = order.recipientPhone == null || order.recipientPhone.trim() === "" ? "no_phone" : e164 ? null : "invalid_phone";
  const context: RenderContext = {
    customerName: order.customerName,
    orderNumber: order.orderNumber,
    storeName: store.name,
    storeSlug: store.slug,
    totalIqd: order.totalIqd,
    cashAtDoor: collectsCashOnDelivery(order.paymentMethodCode),
  };
  const sends = await prisma.orderWhatsappSend.findMany({
    where: { storeId, orderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, templateKey: true, actorKind: true, actorId: true, createdAt: true },
  });
  return {
    orderId: order.id,
    orderStatus: order.status,
    recipientPhone: order.recipientPhone ?? null,
    waReady: e164 !== null,
    reason,
    templates: WHATSAPP_TEMPLATE_KEYS.map((key) => {
      const body = renderWhatsappTemplate(templates[key], context);
      return { key, label: WHATSAPP_TEMPLATE_LABELS[key], body, waUrl: e164 ? waUrlFor(e164, body) : null };
    }),
    sends: await withActorNames(sends),
  };
}

/**
 * Records the tap. Re-renders SERVER-SIDE and stores exactly what rendered;
 * refuses when no link could have existed — an audit row without a possible
 * send would be a fabrication.
 */
export async function recordWhatsappSend(
  storeId: string,
  actor: { kind: "merchant" | "staff"; id: string },
  orderId: string,
  body: Record<string, unknown>,
) {
  const key = body.templateKey;
  if (typeof key !== "string" || !WHATSAPP_TEMPLATE_KEYS.includes(key as WhatsappTemplateKey)) {
    throw new HttpError(422, "INVALID_INPUT", "قالب واتساب غير معروف.");
  }
  const templateKey = key as WhatsappTemplateKey;
  const [order, store] = await Promise.all([scopedOrder(storeId, orderId), storeContext(storeId)]);
  const e164 = toE164(order.recipientPhone);
  if (!e164) {
    throw new HttpError(422, "WHATSAPP_NO_RECIPIENT_PHONE", "لا يوجد رقم هاتف صالح لهذا الطلب، فلا رسالة يمكن إرسالها.");
  }
  const settings = await prisma.notificationSettings.findUnique({ where: { storeId }, select: { configuration: true } });
  const templates = normalizeWhatsappTemplates(settings?.configuration);
  const rendered = renderWhatsappTemplate(templates[templateKey], {
    customerName: order.customerName,
    orderNumber: order.orderNumber,
    storeName: store.name,
    storeSlug: store.slug,
    totalIqd: order.totalIqd,
    cashAtDoor: collectsCashOnDelivery(order.paymentMethodCode),
  });
  const send = await prisma.orderWhatsappSend.create({
    data: {
      storeId,
      orderId: order.id,
      templateKey: TEMPLATE_DB_KEYS[templateKey],
      recipientPhone: e164,
      messageBody: rendered,
      actorKind: actor.kind,
      actorId: actor.id,
    },
    select: { id: true, templateKey: true, actorKind: true, actorId: true, createdAt: true },
  });
  return (await withActorNames([send]))[0];
}
