/**
 * codiq المرحلة 19-ب — طاقم المنصة. Every action calls the server team API;
 * the UI never computes authorization locally. Mirrors StoreTeamManager's
 * structure, not its classes: this file is born on var(--codiq-*) tokens.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, KeyRound, LoaderCircle, RefreshCw, ScrollText, ShieldCheck, UserMinus, UserPlus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInputWithMeter } from "@/components/ui/password-input-with-meter";
import type { PlatformPermissionCode } from "@/config/navigation";

type Override = { permissionCode: string; effect: "allow" | "deny" };
type StaffMember = {
  id: string;
  email: string;
  displayName: string;
  roleCode: "registrations_admin" | "accountant" | "supervisor";
  isActive: boolean;
  permissionVersion: number;
  overrides: Override[];
  permissions: string[];
  totpEnrolled: boolean;
};
type AuditEvent = {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  action: string;
  actorKind: string;
  actorId: string | null;
  actorLabel: string;
  metadata: unknown;
  createdAt: string;
};

const PERMISSION_LABELS: Record<PlatformPermissionCode, string> = {
  "overview.view": "عرض النظرة العامة",
  "registrations.approve": "الموافقة على طلبات التسجيل",
  "merchants.manage": "إدارة التجار والمتاجر",
  "plans.manage": "إدارة الخطط والاشتراكات",
  "finance.view": "عرض المالية",
  "finance.settle": "تنفيذ التسويات",
  "orders.oversee": "الإشراف على الطلبات",
  "brand.manage": "إدارة هوية المنصة",
  "audit.view": "عرض سجل التدقيق",
  "services.manage": "إدارة الخدمات والقدرات",
  "availability.manage": "تجاوزات الإتاحة",
};
const PERMISSION_CODES = Object.keys(PERMISSION_LABELS) as PlatformPermissionCode[];
const ROLE_LABELS = { registrations_admin: "مشرف تسجيلات", accountant: "محاسب", supervisor: "مشرف عام" } as const;
const ACTOR_LABELS: Record<string, string> = { platform_owner: "مالك المنصة", platform_staff: "طاقم المنصة" };

/**
 * Known audit actions rendered in Arabic; anything the server adds later falls
 * back to its raw code rather than hiding the row — the log must stay complete.
 */
const ACTION_LABELS: Record<string, string> = {
  "staff.created": "أُنشئ عضو في الطاقم",
  "staff.role_changed": "غُيّر الدور",
  "staff.activated": "فُعّلت العضوية",
  "staff.deactivated": "أُوقفت العضوية",
  "staff.removed": "أُزيل من الطاقم",
  "staff.overrides_changed": "حُدّثت استثناءات الصلاحيات",
  "staff.totp_reset": "أُعيد ضبط المصادقة الثنائية",
  "staff.totp_enrolled": "فُعّلت المصادقة الثنائية",
  "settlement.created": "أُنشئت تسوية",
  "upgrade_request.decided": "حُسم طلب ترقية",
};

const when = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });
function formatWhen(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : when.format(parsed);
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "تعذر تنفيذ الطلب.");
  return body as T;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "PLATFORM_PERMISSION_DENIED") return "هذه الجلسة لا تملك صلاحية إدارة طاقم المنصة (403).";
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "خطأ غير متوقع.";
}

function OverridesEditor({ member, onSave, busy }: { member: StaffMember; onSave: (overrides: Override[]) => Promise<void>; busy: boolean }) {
  // A plain record, not a Map: the root tsconfig targets ES5 and this stays
  // clear of iteration-protocol downleveling entirely.
  const initial: Record<string, "allow" | "deny"> = {};
  for (let index = 0; index < member.overrides.length; index += 1) initial[member.overrides[index].permissionCode] = member.overrides[index].effect;
  const [draft, setDraft] = useState<Record<string, "allow" | "deny">>(initial);

  return (
    <div className="mt-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4">
      <p className="mb-3 flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]"><ShieldCheck className="h-4 w-4 text-[var(--codiq-accent)]" /> استثناءات الصلاحيات (سماح/منع فوق الدور)</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {PERMISSION_CODES.map((code) => {
          const value = draft[code] ?? "default";
          return (
            <label key={code} className="flex items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface)] px-3 py-2 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm">
              <span>{PERMISSION_LABELS[code]}</span>
              <select
                data-testid={`platform-override-${code}`}
                className="rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 py-1 text-xs"
                value={value}
                onChange={(event) => {
                  const next: Record<string, "allow" | "deny"> = { ...draft };
                  if (event.target.value === "default") delete next[code];
                  else next[code] = event.target.value as "allow" | "deny";
                  setDraft(next);
                }}
              >
                <option value="default">حسب الدور</option>
                <option value="allow">سماح</option>
                <option value="deny">منع</option>
              </select>
            </label>
          );
        })}
      </div>
      <Button
        size="sm"
        disabled={busy}
        data-testid="platform-save-overrides"
        className="mt-3 rounded-xl"
        onClick={() => {
          const overrides: Override[] = [];
          for (let index = 0; index < PERMISSION_CODES.length; index += 1) {
            const effect = draft[PERMISSION_CODES[index]];
            if (effect) overrides.push({ permissionCode: PERMISSION_CODES[index], effect });
          }
          void onSave(overrides);
        }}
      >
        حفظ الاستثناءات
      </Button>
    </div>
  );
}

export function AuditTimeline() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPage = useCallback(async (after: string | null) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api<{ events: AuditEvent[]; nextCursor: string | null }>(`/api/platform/audit-events?limit=30${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
      setEvents((previous) => (after ? (previous ?? []).concat(result.events) : result.events));
      setCursor(result.nextCursor);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void loadPage(null); }, [loadPage]);

  return (
    <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><ScrollText className="h-4 w-4" /> سجل التدقيق</p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">من فعل ماذا، وعلى أي كيان</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">سجل إلحاقي لا يُعدَّل ولا يُحذف — كل إجراء لمالك المنصة أو لعضو من الطاقم يُقيَّد هنا لحظة وقوعه.</p>
      {failure ? <p className="mb-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4 shrink-0" /> {failure}</p> : null}
      {events === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p> : null}
      {events?.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا أحداث بعد.</p> : null}
      <ul className="space-y-3" data-testid="platform-audit-list">
        {events?.map((event) => (
          <li key={event.id} className="rounded-2xl border border-[var(--codiq-border)] px-4 py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
              <span>{ACTION_LABELS[event.action] ?? event.action}</span>
              <span className="shrink-0 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--codiq-text-secondary)]">{event.entityLabel || event.entityType}</span>
            </p>
            <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
              بواسطة {event.actorLabel || ACTOR_LABELS[event.actorKind] || event.actorKind}{event.actorLabel ? ` (${ACTOR_LABELS[event.actorKind] ?? event.actorKind})` : ""} · {formatWhen(event.createdAt)}
            </p>
          </li>
        ))}
      </ul>
      {cursor ? (
        <Button variant="outline" size="sm" disabled={busy} data-testid="platform-audit-more" className="mt-5 rounded-xl" onClick={() => void loadPage(cursor)}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تحميل المزيد"}
        </Button>
      ) : null}
    </div>
  );
}

export function PlatformTeamManager() {
  const [tab, setTab] = useState<"team" | "audit">("team");
  const [team, setTeam] = useState<StaffMember[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Confirm-on-second-click (PosDevicesPanel idiom): `armed` names the one
  // destructive button that is currently the question — "remove:<id>" or
  // "totp:<id>". The timer forgets the question after 3s, and a click landing
  // under 500ms after arming is a double-click, not an answer.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedAt = useRef(0);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  const teamUrl = "/api/platform/staff/team";

  const load = useCallback(async () => {
    try {
      const result = await api<{ team: StaffMember[] }>(teamUrl);
      setTeam(result.team);
      setFailure(null);
    } catch (error) {
      setTeam(null);
      setFailure(errorText(error));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>, successNotice: string) {
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      await action();
      setNotice(successNotice);
      await load();
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function arm(key: string) {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(key);
    armedAt.current = Date.now();
    armTimer.current = setTimeout(() => setArmed(null), 3000);
  }

  async function fireArmed(key: string, action: () => Promise<void>, successNotice: string) {
    if (Date.now() - armedAt.current < 500) return;
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
    await run(action, successNotice);
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = event.currentTarget;
    await run(async () => {
      await api(teamUrl, {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          displayName: form.get("displayName"),
          temporaryPassword: form.get("temporaryPassword"),
          roleCode: form.get("roleCode"),
        }),
      });
      target.reset();
    }, "أُنشئ عضو الطاقم. أرسل له رابط الدخول أدناه مع بريده وكلمة المرور المؤقتة — وسيُلزم بتفعيل المصادقة الثنائية عند أول دخول.");
  }

  return (
    <div className="max-w-[1030px] space-y-5">
      <div className="flex items-center gap-2">
        <Button variant={tab === "team" ? "default" : "outline"} size="sm" className="rounded-xl" onClick={() => setTab("team")}>الطاقم</Button>
        <Button variant={tab === "audit" ? "default" : "outline"} size="sm" data-testid="platform-audit-tab" className="rounded-xl" onClick={() => setTab("audit")}>سجل التدقيق</Button>
      </div>

      {tab === "audit" ? <AuditTimeline /> : (
        <>
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UserPlus className="h-4 w-4" /> إنشاء عضو بكلمة مرور مؤقتة</p>
        <h2 className="mb-5 text-xl font-bold text-[var(--codiq-text)]">إضافة عضو إلى طاقم المنصة</h2>
        <form onSubmit={submitCreate} className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]"><span>البريد الإلكتروني</span><Input data-testid="platform-team-create-email" name="email" type="email" required /></label>
          <label className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]"><span>الاسم الظاهر</span><Input data-testid="platform-team-create-name" name="displayName" required minLength={2} /></label>
          <div className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]"><label htmlFor="platform-team-create-password-field">كلمة مرور مؤقتة (8 خانات فأكثر)</label><PasswordInputWithMeter id="platform-team-create-password-field" data-testid="platform-team-create-password" name="temporaryPassword" required minLength={8} /></div>
          <label className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]"><span>الدور</span>
            <select data-testid="platform-team-create-role" name="roleCode" required defaultValue="registrations_admin" className="h-9 w-full rounded-md border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm">
              <option value="registrations_admin">{ROLE_LABELS.registrations_admin}</option>
              <option value="accountant">{ROLE_LABELS.accountant}</option>
              <option value="supervisor">{ROLE_LABELS.supervisor}</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <Button data-testid="platform-team-create-submit" disabled={busy} className="rounded-xl">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "إنشاء العضو"}</Button>
          </div>
        </form>
      </div>

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex items-center justify-between">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UsersRound className="h-4 w-4" /> أعضاء الطاقم</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
        </div>
        {failure ? <p data-testid="platform-team-error" className="mb-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4 shrink-0" /> {failure}</p> : null}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3 text-xs font-semibold text-[var(--codiq-accent-on-soft)]">
          <span>رابط دخول الطاقم:</span>
          <code dir="ltr" className="rounded-lg bg-[var(--codiq-surface)] px-2 py-1 font-bold">{`${window.location.origin}/platform/staff/login`}</code>
          <button type="button" data-testid="platform-team-copy-login-link" className="rounded-lg border border-[var(--codiq-accent-on-soft)] px-2 py-1 font-bold transition hover:bg-[var(--codiq-surface)]" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/platform/staff/login`).catch(() => {}); setNotice("نُسخ رابط الدخول — أرسله لعضو الطاقم."); }}>نسخ</button>
        </div>
        {notice ? <p data-testid="platform-team-notice" className="mb-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
        {team === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p> : null}
        {team?.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا أعضاء بعد؛ أنشئ أول عضو من النموذج أعلاه.</p> : null}
        <div className="space-y-3">
          {team?.map((member) => (
            <div key={member.id} data-testid={`platform-team-row-${member.email}`} className={`rounded-2xl border px-4 py-4 ${member.isActive ? "border-[var(--codiq-border)] bg-[var(--codiq-surface)]" : "border-dashed border-[var(--codiq-danger-border)] bg-[var(--codiq-danger-soft)]"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--codiq-text)]">{member.displayName}</p>
                  <p className="truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">{member.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid="platform-team-role-select"
                    className="rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 py-1.5 text-xs font-semibold"
                    value={member.roleCode}
                    disabled={busy}
                    onChange={(event) => void run(async () => { await api(`${teamUrl}/${member.id}`, { method: "PATCH", body: JSON.stringify({ roleCode: event.target.value }) }); }, "تغيّر الدور — الصلاحيات تُحسم من جديد مع كل طلب.")}
                  >
                    <option value="registrations_admin">{ROLE_LABELS.registrations_admin}</option>
                    <option value="accountant">{ROLE_LABELS.accountant}</option>
                    <option value="supervisor">{ROLE_LABELS.supervisor}</option>
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="platform-team-active-toggle"
                    className={member.isActive ? "rounded-xl border-[var(--codiq-danger-border)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]" : "rounded-xl border-[var(--codiq-border)] text-[var(--codiq-success)] hover:bg-[var(--codiq-success-soft)]"}
                    onClick={() => void run(async () => { await api(`${teamUrl}/${member.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !member.isActive }) }); }, member.isActive ? "أُوقفت العضوية وجلساتها تُرفض فوراً. العضو يبقى في القائمة." : "أُعيد تفعيل العضوية.")}
                  >
                    {member.isActive ? "إيقاف" : "تفعيل"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-testid="platform-team-totp-reset"
                    className={armed === `totp:${member.id}` ? "rounded-xl font-bold text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)] hover:text-[var(--codiq-danger)]" : "rounded-xl text-[var(--codiq-text-secondary)]"}
                    onClick={() => (armed === `totp:${member.id}`
                      ? void fireArmed(`totp:${member.id}`, async () => { await api(`${teamUrl}/${member.id}/totp/reset`, { method: "POST" }); }, "أُعيد ضبط المصادقة الثنائية وأُبطلت جلساته — سيُلزم بالتفعيل من جديد عند دخوله التالي.")
                      : arm(`totp:${member.id}`))}
                  >
                    <KeyRound className="ml-1 h-3.5 w-3.5" />{armed === `totp:${member.id}` ? "متأكد؟ اضغط ثانية" : "إعادة ضبط المصادقة الثنائية"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-testid="platform-team-remove"
                    className={armed === `remove:${member.id}` ? "rounded-xl font-bold text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)] hover:text-[var(--codiq-danger)]" : "rounded-xl text-[var(--codiq-text-secondary)]"}
                    onClick={() => (armed === `remove:${member.id}`
                      ? void fireArmed(`remove:${member.id}`, async () => { await api(`${teamUrl}/${member.id}`, { method: "DELETE" }); }, "أُزيل العضو من الطاقم وأُبطلت جلساته.")
                      : arm(`remove:${member.id}`))}
                  >
                    <UserMinus className="ml-1 h-3.5 w-3.5" />{armed === `remove:${member.id}` ? "متأكد؟ اضغط ثانية" : "إزالة من الطاقم"}
                  </Button>
                  <Button size="sm" variant="ghost" className="rounded-xl text-[var(--codiq-text-secondary)]" onClick={() => setExpanded(expanded === member.id ? null : member.id)}>
                    {expanded === member.id ? "إخفاء الصلاحيات" : "الصلاحيات"}
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-on-soft)]">{ROLE_LABELS[member.roleCode]}</span>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${member.isActive ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`}>{member.isActive ? "نشطة" : "موقوفة"}</span>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${member.totpEnrolled ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]"}`}>{member.totpEnrolled ? "مفعّل" : "بانتظار التفعيل"}</span>
                {member.permissions.map((permission) => (
                  <span key={permission} className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--codiq-text-secondary)]">{PERMISSION_LABELS[permission as PlatformPermissionCode] ?? permission}</span>
                ))}
              </div>
              {expanded === member.id ? (
                <OverridesEditor
                  member={member}
                  busy={busy}
                  onSave={(overrides) => run(async () => { await api(`${teamUrl}/${member.id}/overrides`, { method: "PUT", body: JSON.stringify({ overrides }) }); }, "حُفظت استثناءات الصلاحيات — تسري من الطلب التالي دون إبطال الجلسة.")}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
        </>
      )}
    </div>
  );
}
