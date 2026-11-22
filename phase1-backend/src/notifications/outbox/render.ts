/**
 * Outbox worker — render. Split verbatim from outbox-worker.ts
 * (review batch 5, ت-١); outbox-worker.ts re-exports what it always exported.
 */
import { publicUrl } from "../messaging-compliance.service.js";
import { ORDER_STATUS_LABELS_AR } from "../../services/order-status-labels.js";
import { courierDispatchedMessage } from "../courier-message.js";
import { openSecret } from "../../auth/secret-box.js";
import { MAINTENANCE_NOTICE_EVENTS, maintenanceMessage } from "../maintenance-message.js";
import { supportReplyToFromEnv } from "../notification-provider.js";
import { stockForecastFor } from "../../services/stock-forecast.service.js";

interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * PG-3: a relative path is not a link in an email.
 *
 * Payloads store relative paths on purpose — they are a durable snapshot of
 * WHICH page and they survive a domain change — so the renderer is where they
 * become absolute. Before this, «تابع طلبك من هنا: /store/x/track» went out
 * verbatim: an unclickable string in a customer's inbox.
 *
 * When no public base URL is configured the whole line is dropped rather than
 * shipping the broken path. Operational mail is still worth sending without its
 * link; a marketing message without its unsubscribe link is not, and the send
 * guard below refuses it.
 */
// Review batch 5, ت-٤: the shopper's words, not the database codes.
function statusLabel(code: unknown): string {
  const text = String(code ?? "");
  return ORDER_STATUS_LABELS_AR[text] ?? text;
}

function linkLine(prefix: string, relativePath: unknown): string {
  const path = typeof relativePath === "string" && relativePath ? relativePath : null;
  const absolute = path ? publicUrl(path) : null;
  return absolute ? `\n${prefix} ${absolute}` : "";
}

export function renderMessage(row: {
  eventType: string;
  recipientKind: string;
  payload: unknown;
}): RenderedMessage {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const storeName = String(payload.storeName ?? "متجرك");
  if (row.eventType === "order.created") {
    const orderNumber = String(payload.orderNumber ?? "");
    if (row.recipientKind === "merchant") {
      return {
        subject: `طلب جديد ${orderNumber}`,
        body: `وصل طلب جديد إلى ${storeName}.\nرقم الطلب: ${orderNumber}\nالزبون: ${String(payload.customerName ?? "")}\nالإجمالي: ${String(payload.totalIqd ?? "")} د.ع`,
      };
    }
    return {
      subject: `تأكيد طلبك ${orderNumber}`,
      body: `استلمنا طلبك من ${storeName}.\nرقم الطلب: ${orderNumber}\nالإجمالي: ${String(payload.totalIqd ?? "")} د.ع\nسنعلمك عند تغير حالة الطلب.`,
    };
  }
  if (row.eventType === "order.status_changed") {
    const orderNumber = String(payload.orderNumber ?? "");
    return {
      subject: `تحديث حالة الطلب ${orderNumber}`,
      body: `تغيرت حالة الطلب ${orderNumber} في ${storeName} من ${statusLabel(payload.fromStatus)} إلى ${statusLabel(payload.toStatus)}.`,
    };
  }
  // CD-1b: «مندوبك في الطريق» — the courier-dispatched notice, customers only.
  if (row.eventType === "order.courier_dispatched")
    return courierDispatchedMessage(storeName, payload, linkLine);
  // Phase 20B-2: abandoned-cart recovery message (customers with email only).
  if (row.eventType === "cart.abandoned") {
    const couponCode =
      typeof payload.couponCode === "string" && payload.couponCode ? payload.couponCode : null;
    return {
      subject: `سلتك في ${storeName} بانتظارك`,
      body:
        `تركت ${String(payload.itemCount ?? "")} من المنتجات في سلتك لدى ${storeName} بقيمة ${String(payload.totalIqd ?? "")} د.ع.` +
        linkLine("أكمل طلبك من هنا:", payload.cartUrl) +
        (couponCode ? `\nاستخدم الكوبون ${couponCode} عند إتمام الطلب للحصول على خصمك.` : ""),
    };
  }
  // PR-1: «استعادة كلمة السر». Above the fallback for the same reason every
  // other branch is — an unmatched event type renders as a LOW-STOCK ALERT, and
  // a person recovering his account would be told his stock is running out.
  //
  // The link arrives SEALED (secret-box, purpose `password-reset-link`) because
  // `password_reset_tokens` stores only a hash and a plaintext link in
  // `payload` would put that same secret back into the database. It is opened
  // HERE, at send time, and the plaintext exists only for the length of this
  // function. A row whose envelope will not open is a row that was tampered
  // with or sealed under a withdrawn key: `openSecret` throws, the worker's
  // catch turns that into a retry and then a dead letter, which is the correct
  // ending — a reset mail that cannot be built must never go out half-written.
  if (row.eventType === "auth.password_reset") {
    const minutes = String(payload.expiresInMinutes ?? 45);
    const link = openSecret("password-reset-link", String(payload.resetUrlSealed ?? ""));
    return {
      subject: "استعادة كلمة السر في Codiq",
      body:
        `وصلنا طلب لإعادة تعيين كلمة السر لحسابك.` +
        `\n\nافتح الرابط التالي واختر كلمة سر جديدة:\n${link}` +
        `\n\nالرابط صالح لمدة ${minutes} دقيقة، ولمرة واحدة فقط.` +
        `\nعند استخدامه ستُنهى كل الجلسات المفتوحة على حسابك، ويلزمك تسجيل الدخول من جديد.` +
        // Said plainly, because the person who did NOT ask is the one who most
        // needs to know what to do: nothing. No account changes until the link
        // is opened, so ignoring the message is a complete answer.
        `\n\nإن لم تطلب هذا، فلا حاجة لأي إجراء — لم يتغير شيء في حسابك، والرابط ينتهي وحده.`,
    };
  }
  // ق-250: a maintenance window that touches this merchant (scheduled, ended, cancelled).
  if ((MAINTENANCE_NOTICE_EVENTS as readonly string[]).includes(row.eventType))
    return maintenanceMessage(row.eventType, payload);
  // ق-186 (D-90): the trial is ending. The one message that turns a silent
  // downgrade into a decision he was actually offered.
  //
  // It names the date, the days left and the plan he lands on, and it says
  // plainly that nothing is deleted and no shop closes — because the fear this
  // message creates ("do I lose my shop?") is worse than the fact, and a
  // merchant who is frightened by his own platform does not come back to read
  // the second paragraph. ق-128's job guarantees the landing is real: he moves
  // to the free plan, he is never left without a subscription.
  if (row.eventType === "trial.ending") {
    const days = Number(payload.daysLeft ?? 3);
    const endsAt = payload.endsAt ? new Date(String(payload.endsAt)) : null;
    const date = endsAt ? endsAt.toISOString().slice(0, 10) : null;
    const remaining = days === 1 ? "غداً" : days === 2 ? "بعد يومين" : `بعد ${days} أيام`;
    // The closing invitation is conditional on ق-184's reply address actually
    // existing. Telling a merchant to «reply to this message» when the platform
    // set no Reply-To would send him at `no-reply@` and bounce — a promise the
    // deployment cannot keep is worse than no invitation at all.
    const replyTo = supportReplyToFromEnv();
    return {
      subject: `تجربتك المجانية في Codiq تنتهي ${remaining}`,
      body:
        `تنتهي تجربتك المجانية ${remaining}${date ? ` (${date})` : ""}.` +
        `\n\nبعدها ينتقل حسابك تلقائياً إلى الخطة المجانية. متجرك يبقى مفتوحاً، وطلباتك وزبائنك ومنتجاتك كما هي — لا يُحذف شيء ولا يتوقف بيع.` +
        `\nالذي يتغير هو حدود الخطة فقط.` +
        (replyTo
          ? `\n\nإن أردت البقاء على خطتك الحالية، راسلنا بالرد على هذه الرسالة قبل انتهاء المدة.`
          : ``),
    };
  }
  // MD-3: the merchant's own daily summary. This sits ABOVE the fallback below,
  // which renders ANY unmatched event type as a low-stock alert — a digest
  // landing there would reach him dressed as a stock warning.
  if (row.eventType === "merchant.daily_digest") {
    const waiting = Number(payload.ordersWaiting ?? 0);
    return {
      subject: `ملخص يومك في ${storeName} — ${String(payload.date ?? "")}`,
      body:
        `طلبات اليوم: ${String(payload.ordersToday ?? 0)}` +
        `\nمبيعات اليوم: ${String(payload.revenueTodayIqd ?? 0)} د.ع` +
        // Said only when there is something to act on. A line reading «0 بانتظارك»
        // every evening is how a merchant learns to skim past the evening it says 12.
        (waiting > 0 ? `\n\n${waiting} طلباً ينتظر تجهيزك.` : ""),
    };
  }
  // CD-2: back in stock. Above the fallback below for the same reason every
  // other branch is — an unmatched event type renders as a LOW-STOCK ALERT, so
  // a shopper would be told his shirt is running out at the shop he does not own.
  if (row.eventType === "stock.back_in_stock") {
    const productName = String(payload.productName ?? "");
    return {
      subject: `${productName} عاد للتوفر في ${storeName}`,
      body:
        `طلبت أن نُنبّهك عندما يعود «${productName}» — وقد عاد الآن إلى ${storeName}.` +
        `\nالسعر: ${String(payload.priceIqd ?? "")} د.ع` +
        linkLine("اطلبه من هنا:", payload.productUrl) +
        // Said plainly: this is a one-time answer to one request, not a
        // subscription he now has to escape from.
        `\n\nهذا تنبيه لمرة واحدة عن طلبك. إن أردت تنبيهاً آخر لاحقاً، أعد طلبه من قائمة رغباتك.`,
    };
  }
  return {
    subject: `تنبيه مخزون منخفض — ${String(payload.productName ?? "")}`,
    body:
      `انخفض مخزون المنتج ${String(payload.productName ?? "")} (SKU: ${String(payload.sku ?? "")}) في ${storeName} إلى ${String(payload.stockQuantity ?? "")} قطعة.` +
      // MD-3: the forecast is attached by the worker at SEND time, not at enqueue
      // time — he may have restocked since — and is absent entirely when the
      // product has not sold enough for a rate to mean anything.
      (typeof payload.daysRemaining === "number"
        ? `\nبمعدل بيعك في آخر ${String(payload.forecastWindowDays ?? 14)} يوماً، يكفي هذا المخزون ~${String(payload.daysRemaining)} يوماً.`
        : ""),
  };
}

/**
 * MD-3: attaches «سينفد خلال ~N أيام» to a low-stock alert, at SEND time.
 *
 * Not at enqueue time: that write happens inside the stock transaction on the
 * checkout path, and a forecast query there would put two extra reads in front
 * of every sale. Here the worker is already out of the request path, and the
 * figure is also fresher — the merchant may have restocked since the alert was
 * queued, in which case the estimate that goes out is the one that is true when
 * it is read.
 *
 * A failure adds nothing and loses nothing: the alert itself is the message, and
 * the forecast is a courtesy on top of it.
 */
// Generic on the row type, not narrowed to the three fields this function reads:
// a concrete parameter type would hand `renderMessage` back a row stripped of
// `recipientKind`, which it needs to tell a merchant's copy from a customer's.
export async function withStockForecast<
  T extends { eventType: string; storeId: string | null; payload: unknown },
>(row: T): Promise<T> {
  // PR-1: `storeId` is nullable now. A low-stock alert always has one — the
  // CHECK constraint sees to that — so this is a type narrowing rather than a
  // new case, and a forecast is a courtesy that adds nothing when it cannot run.
  if (row.eventType !== "low_stock" || !row.storeId) return row;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const variantId = typeof payload.variantId === "string" ? payload.variantId : null;
  if (!variantId) return row;
  try {
    const forecast = await stockForecastFor(row.storeId, variantId);
    if (!forecast) return row;
    return {
      ...row,
      payload: {
        ...payload,
        daysRemaining: forecast.daysRemaining,
        forecastWindowDays: forecast.windowDays,
      },
    };
  } catch {
    return row;
  }
}
