/**
 * codiq phase 15 — merchant notification preferences + delivery log.
 * The server computes authorization (settings.manage or store ownership) and
 * never returns provider secrets; this component only displays and toggles.
 */
import { useCallback, useEffect, useState } from "react";
import { BellRing, CircleAlert, LoaderCircle, MailCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Preferences = { orderCreated: boolean; orderStatusChanged: boolean; lowStock: boolean };
type SettingsView = {
  caps?: {
    marketingDailyCap: number;
    operationalDailyCap: number;
    operationalRecipientDailyCap: number;
  };
  isEnabled: boolean;
  preferences: Preferences;
  courierDispatch?: { enabled: boolean };
  dailyDigest?: { enabled: boolean; hour: number };
  senderId: string | null;
  emailProviderConfigured: boolean;
  smsProviderConfigured: boolean;
  whatsappTemplates?: Record<string, string>;
  whatsappMode?: string;
};

/**
 * WA-1 (ق-131/ق-139): the three manual-WhatsApp occasions. The keys mirror the
 * server allow-list; the testid suffixes are the kebab forms the browser suite
 * clicks. Free text saves on an EXPLICIT button (DeliveryRatesManager
 * precedent), never on change.
 */
const WHATSAPP_TEMPLATE_ROWS = [
  { key: "orderCreated", testid: "whatsapp-template-order-created", label: "تأكيد استلام الطلب" },
  {
    key: "courierDispatched",
    testid: "whatsapp-template-courier-dispatched",
    label: "المندوب في الطريق",
  },
  { key: "orderCompleted", testid: "whatsapp-template-order-completed", label: "شكر بعد التسليم" },
] as const;
const WHATSAPP_VARIABLES = [
  "{{اسم_الزبون}}",
  "{{رقم_الطلب}}",
  "{{اسم_المتجر}}",
  "{{المبلغ}}",
  "{{رابط_التتبع}}",
];
type LogRow = {
  id: string;
  eventType: string;
  recipientKind: string;
  channel: string;
  recipient: string | null;
  status: string;
  attemptCount: number;
  lastOutcome: string | null;
  sentAt: string | null;
  createdAt: string;
  summary: { orderNumber: string | null; productName: string | null; toStatus: string | null };
};

const EVENT_LABELS: Record<string, string> = {
  "order.created": "طلب جديد",
  "order.status_changed": "تغيير حالة طلب",
  low_stock: "مخزون منخفض",
  "cart.abandoned": "استرداد سلة متروكة",
  "order.courier_dispatched": "مندوبك في الطريق",
};
/**
 * ق-165 — the WHY behind a status the merchant can already see.
 *
 * The outbox worker writes a precise reason on every row — a daily cap, an
 * unsubscribe, a missing provider — and `lastOutcome` was declared in the type
 * above and rendered nowhere. So a merchant whose messages stopped saw the word
 * «إعادة محاولة» and no explanation, for a delay that lasts until tomorrow.
 *
 * Values carrying a number arrive as `key:number` (the cap that was hit).
 * A successful send returns null on purpose: the status badge already says it,
 * and repeating it as prose would bury the rows that need reading.
 */
function outcomeReason(outcome: string | null): string | null {
  if (!outcome) return null;
  const separator = outcome.indexOf(":");
  const key = separator === -1 ? outcome : outcome.slice(0, separator);
  const value = separator === -1 ? "" : outcome.slice(separator + 1);
  switch (key) {
    case "daily_cap_deferred":
    case "store_daily_cap_deferred":
      return `بلغ المتجر سقفه اليومي للرسائل (${value}) — تُرسل غدًا.`;
    case "recipient_daily_cap_deferred":
      return `بلغ هذا المستلم سقفه اليومي (${value}) — تُرسل غدًا.`;
    // ق-207: the marketing channel's per-recipient ceiling is terminal, not a deferral.
    case "recipient_daily_cap":
      return `بلغ هذا العنوان سقف الرسائل التسويقية اليومي (${value}) على المنصة — لم تُرسل.`;
    case "recipient_unsubscribed":
      return "المستلم ألغى اشتراكه في الرسائل التسويقية.";
    case "marketing_disabled_for_store":
      return "الرسائل التسويقية معطّلة لهذا المتجر.";
    case "marketing_without_store":
      return "رسالة تسويقية بلا متجر، فلا يمكن إرفاق رابط إلغاء الاشتراك.";
    case "missing_unsubscribe_link":
      return "رسالة تسويقية بلا رابط إلغاء اشتراك، فلم تُرسل.";
    case "no_provider_configured":
      return "لا مزوّد بريد مهيّأ على المنصة — راجع مالك المنصة.";
    case "no_recipient_address":
      return "لا عنوان للمستلم.";
    case "provider_threw":
      return "رفض مزوّد البريد الرسالة، وتُعاد المحاولة.";
    // These two carry the provider's own code after the colon — it is what a
    // support ticket needs, so it is shown rather than smoothed away.
    case "http_failed":
      return `تعذّر الإرسال عبر مزوّد البريد (${value}) وتُعاد المحاولة.`;
    case "smtp_failed":
      return `تعذّر الاتصال بخادم البريد (${value}) وتُعاد المحاولة.`;
    case "sms_not_configured":
      return "لا مزوّد رسائل نصية مهيّأ على المنصة — راجع مالك المنصة.";
    case "stale_claim_recovered":
      return "استُعيدت بعد توقّف العامل، وتُعاد المحاولة.";
    case "http_accepted":
    case "smtp_accepted":
      return null;
    default:
      return null;
  }
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending: { label: "بالانتظار", className: "bg-[var(--codiq-accent-soft)] text-[#1B64C4]" },
  processing: { label: "قيد الإرسال", className: "bg-[var(--codiq-warning-soft)] text-[#A76B13]" },
  sent: { label: "أُرسل", className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  retry_scheduled: { label: "إعادة محاولة", className: "bg-[#F2EEFF] text-[#6955B7]" },
  dead_letter: { label: "فشل نهائي", className: "bg-[var(--codiq-danger-soft)] text-[#B52D46]" },
  skipped: { label: "تخطي", className: "bg-[var(--codiq-neutral-soft)] text-[#65748B]" },
};
const PREFERENCE_LABELS: Record<keyof Preferences, string> = {
  orderCreated: "طلب جديد",
  orderStatusChanged: "تغيير حالة الطلب",
  lowStock: "انخفاض المخزون",
};
const dateTime = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "تعذر تنفيذ الطلب."
    );
  return body as T;
}

export function NotificationCenter({ storeSlug }: { storeSlug?: string }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waDrafts, setWaDrafts] = useState<Record<string, string> | null>(null);
  const base = storeSlug
    ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/notifications`
    : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const [settingsResult, logResult] = await Promise.all([
        api<{ settings: SettingsView }>(`${base}/settings`),
        api<{ notifications: LogRow[] }>(`${base}/log?limit=25`),
      ]);
      setSettings(settingsResult.settings);
      setLog(logResult.notifications);
      setFailure(null);
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.code === "STAFF_PERMISSION_DENIED"
          ? "هذه الجلسة لا تملك صلاحية إدارة الإعدادات (403)."
          : error instanceof Error
            ? error.message
            : "خطأ غير متوقع."
      );
      setSettings(null);
      setLog(null);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: {
    isEnabled?: boolean;
    preferences?: Partial<Preferences>;
    courierDispatch?: { enabled: boolean };
    dailyDigest?: { enabled?: boolean; hour?: number };
    whatsappTemplates?: Record<string, string>;
  }) {
    if (!base) return false;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ settings: SettingsView }>(`${base}/settings`, {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setSettings(result.settings);
      setNotice("حُفظت التفضيلات.");
      setFailure(null);
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // WA-1: template drafts live locally until the explicit save — free text must
  // never fire a PUT per keystroke. null means «no unsaved edits».
  async function saveWhatsappDrafts() {
    if (!waDrafts) return;
    if (await save({ whatsappTemplates: waDrafts })) setWaDrafts(null);
  }

  if (!storeSlug) {
    return (
      <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 text-sm font-semibold text-[var(--codiq-danger)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        افتح اللوحة عبر مسار متجر محدد قبل إدارة الإشعارات.
      </div>
    );
  }

  return (
    <div className="max-w-[1030px] space-y-5">
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <BellRing className="h-4 w-4" /> إشعارات المتجر (Outbox موثوق المعاملات)
        </p>
        <h2 className="mb-1 text-xl font-bold text-[#263650]">ماذا يصلك من أحداث متجرك؟</h2>
        <p className="mb-5 text-sm leading-6 text-[var(--codiq-text-muted)]">
          يُسجل كل حدث داخل معاملة العملية نفسها ثم يُرسل عبر عامل مستقل بإعادة محاولات تلقائية.
        </p>
        {failure ? (
          <p
            data-testid="notif-error"
            className="mb-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          >
            <CircleAlert className="h-4 w-4" /> {failure}
          </p>
        ) : null}
        {notice ? (
          <p
            data-testid="notif-notice"
            className="mb-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          >
            {notice}
          </p>
        ) : null}
        {settings === null && !failure ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">
            <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
          </p>
        ) : null}
        {settings ? (
          <div className="space-y-4">
            <label className="flex items-center justify-between rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3">
              <span className="text-sm font-bold text-[#33435D]">تفعيل الإشعارات لهذا المتجر</span>
              <input
                data-testid="notif-enable"
                type="checkbox"
                className="h-5 w-5 accent-[var(--codiq-accent)]"
                checked={settings.isEnabled}
                disabled={busy}
                onChange={(event) => void save({ isEnabled: event.target.checked })}
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(PREFERENCE_LABELS) as (keyof Preferences)[]).map((key) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface)] px-3 py-2.5 text-sm font-semibold text-[#44526A] shadow-sm"
                >
                  <span>{PREFERENCE_LABELS[key]}</span>
                  <input
                    data-testid={`notif-pref-${key}`}
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--codiq-accent)]"
                    checked={settings.preferences[key]}
                    disabled={busy || !settings.isEnabled}
                    onChange={(event) =>
                      void save({ preferences: { [key]: event.target.checked } })
                    }
                  />
                </label>
              ))}
            </div>
            {/* CD-1b lives in configuration (phase 15 pins `preferences` to three
                keys), so it renders as its own row rather than inside the grid. */}
            <label className="flex items-center justify-between rounded-2xl bg-[var(--codiq-surface)] px-4 py-3 text-sm font-semibold text-[#44526A] shadow-sm">
              <span>رسالة «مندوبك في الطريق» للزبون عند خروج الطلب للتوصيل</span>
              <input
                data-testid="notif-courier-dispatch"
                type="checkbox"
                className="h-4 w-4 accent-[var(--codiq-accent)]"
                checked={settings.courierDispatch?.enabled ?? true}
                disabled={busy || !settings.isEnabled}
                onChange={(event) =>
                  void save({ courierDispatch: { enabled: event.target.checked } })
                }
              />
            </label>
            {/* MD-3: real columns rather than a block in `configuration`, because
                the digest scanner filters on them in SQL. Off until he asks —
                a daily email nobody wanted is how a shared sending domain earns
                a spam reputation. */}
            <div className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-3 shadow-sm">
              <label className="flex items-center justify-between text-sm font-semibold text-[#44526A]">
                <span>ملخص يومي لمتجرك على بريدك (مبيعات اليوم وطلبات تنتظرك)</span>
                <input
                  data-testid="notif-daily-digest"
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--codiq-accent)]"
                  checked={settings.dailyDigest?.enabled ?? false}
                  disabled={busy || !settings.isEnabled}
                  onChange={(event) =>
                    void save({ dailyDigest: { enabled: event.target.checked } })
                  }
                />
              </label>
              {settings.dailyDigest?.enabled ? (
                <label className="mt-2.5 flex items-center justify-between gap-3 border-t border-[var(--codiq-neutral-soft)] pt-2.5 text-xs font-semibold text-[#65748B]">
                  <span>يُرسل بعد الساعة (بتوقيت بغداد)</span>
                  <select
                    data-testid="notif-digest-hour"
                    value={settings.dailyDigest.hour}
                    disabled={busy}
                    onChange={(event) =>
                      void save({ dailyDigest: { hour: Number(event.target.value) } })
                    }
                    className="rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2.5 py-1.5 text-xs text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-xs font-semibold text-[#65748B]">
              <MailCheck className="h-4 w-4 text-[var(--codiq-accent)]" />
              {settings.emailProviderConfigured
                ? "قناة البريد مفعّلة على مستوى المنصة."
                : "قناة البريد غير مهيأة بعد على مستوى المنصة؛ ستُعلَّم الرسائل «تخطي» حتى إضافة بيانات SMTP."}{" "}
              قناة SMS العراقية ستُفعل مع مرحلة التكاملات.
            </p>
            {settings.caps ? (
              <p
                data-testid="notif-caps"
                className="rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-xs leading-5 text-[var(--codiq-text-secondary)]"
              >
                {/* ق-180: the ceilings the worker enforces, so a deferred day is not a mystery. Set by the platform, not here. */}
                سقوف يومية تحدّدها المنصة: تسويقية{" "}
                <strong dir="ltr">{settings.caps.marketingDailyCap}</strong> · تشغيلية{" "}
                <strong dir="ltr">{settings.caps.operationalDailyCap}</strong> · للمستلم الواحد{" "}
                <strong dir="ltr">{settings.caps.operationalRecipientDailyCap}</strong>. فوق السقف
                تُؤجَّل الرسالة إلى الغد ولا تُحذف.
              </p>
            ) : null}

            {/* WA-1 (ق-131/ق-139): قوالب واتساب. A sibling block in configuration
                (never inside the pinned preferences trio). The wording is honest
                by rule: manual prefilled links, never claimed as automation. */}
            <div className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-[var(--codiq-text)]">قوالب واتساب</p>
                <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1 text-[10px] font-bold text-[var(--codiq-text-secondary)]">
                  إرسال يدوي — يفتح تطبيقك برسالة جاهزة. الإرسال الآلي يصل لاحقاً.
                </span>
              </div>
              <p className="mt-2 text-xs leading-6 text-[var(--codiq-text-secondary)]">
                الرسالة التي تُجهَّز لك من صفحة الطلب لكل مناسبة. المتغيرات المتاحة:
                {WHATSAPP_VARIABLES.map((token) => (
                  <code
                    key={token}
                    dir="ltr"
                    className="mx-0.5 inline-block rounded bg-[var(--codiq-canvas)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--codiq-accent-on-soft)]"
                  >
                    {token}
                  </code>
                ))}
              </p>
              <div className="mt-3 space-y-3">
                {WHATSAPP_TEMPLATE_ROWS.map((row) => (
                  <label key={row.key} className="block">
                    <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">
                      {row.label}
                    </span>
                    <textarea
                      data-testid={row.testid}
                      rows={3}
                      disabled={busy}
                      value={waDrafts?.[row.key] ?? settings.whatsappTemplates?.[row.key] ?? ""}
                      onChange={(event) =>
                        setWaDrafts((current) => ({
                          ...(current ?? settings.whatsappTemplates ?? {}),
                          [row.key]: event.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm leading-7 text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent-soft)]"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-[11px] leading-5 text-[var(--codiq-text-muted)]">
                  ترك القالب فارغاً يعيده إلى النص الافتراضي.
                </p>
                <Button
                  data-testid="whatsapp-templates-save"
                  type="button"
                  size="sm"
                  disabled={busy || !waDrafts}
                  onClick={() => void saveWhatsappDrafts()}
                  className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
                >
                  {busy ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}حفظ
                  القوالب
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex items-center justify-between">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
            سجل آخر الإشعارات
          </p>
          <Button
            data-testid="notif-refresh"
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="rounded-xl text-[var(--codiq-text-secondary)]"
          >
            <RefreshCw className="ml-1 h-4 w-4" /> تحديث
          </Button>
        </div>
        {log === null && !failure ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
        ) : null}
        {log?.length === 0 ? (
          <p data-testid="notif-empty" className="text-sm text-[var(--codiq-text-muted)]">
            لا توجد إشعارات بعد؛ ستظهر هنا فور وقوع أول حدث.
          </p>
        ) : null}
        <div className="space-y-2">
          {log?.map((row) => {
            const status = STATUS_LABELS[row.status] ?? {
              label: row.status,
              className: "bg-[var(--codiq-neutral-soft)] text-[#65748B]",
            };
            return (
              <div
                key={row.id}
                data-testid={`notif-log-row-${row.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[#263650]">
                    {EVENT_LABELS[row.eventType] ?? row.eventType}
                    {row.summary.orderNumber ? (
                      <span
                        className="mr-2 text-xs font-semibold text-[var(--codiq-accent)]"
                        dir="ltr"
                      >
                        {row.summary.orderNumber}
                      </span>
                    ) : null}
                    {row.summary.productName ? (
                      <span className="mr-2 text-xs font-semibold text-[#6955B7]">
                        {row.summary.productName}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--codiq-text-muted)]">
                    {row.recipientKind === "merchant" ? "إلى التاجر" : "إلى الزبون"} ·{" "}
                    {row.channel === "email" ? "بريد" : "SMS"}
                    {row.recipient ? (
                      <span dir="ltr" className="mr-1">
                        {row.recipient}
                      </span>
                    ) : null}{" "}
                    · {dateTime.format(new Date(row.createdAt))}
                  </p>
                  {outcomeReason(row.lastOutcome) ? (
                    <p
                      data-testid="notif-reason"
                      className="mt-1 text-[11px] leading-5 text-[var(--codiq-text-muted)]"
                    >
                      {outcomeReason(row.lastOutcome)}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {row.attemptCount > 1 ? (
                    <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#65748B]">
                      محاولات: {row.attemptCount}
                    </span>
                  ) : null}
                  <span
                    data-testid="notif-status"
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${status.className}`}
                  >
                    {status.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
