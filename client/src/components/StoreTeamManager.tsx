/**
 * codiq phase 14 — merchant team management. Every action calls the server team API;
 * the UI never computes authorization locally.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, RefreshCw, ShieldCheck, UserMinus, UserPlus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
// PG-2 (plan §1.و exception 6): `is_active` now carries two meanings, so the UI
// must name them apart — «إيقاف» keeps the member in the roster, «إزالة من
// الفريق» moves the membership to the trash bin and kills its sessions.
import { DeleteConfirmSheet, UndoBar, type DeleteTarget, type SoftDeleteResponse } from "@/components/DeleteConfirmSheet";
import { PasswordInputWithMeter } from "@/components/ui/password-input-with-meter";
import type { StorePermissionCode } from "@/config/navigation";

type Override = { permissionCode: string; effect: "allow" | "deny" };
type Membership = {
  id: string;
  roleCode: "store_manager" | "store_staff";
  isActive: boolean;
  permissionVersion: number;
  staff: { id: string; email: string; displayName: string; isActive: boolean };
  overrides: Override[];
  permissions: string[];
};

const PERMISSION_LABELS: Record<StorePermissionCode, string> = {
  "catalog.products.view": "عرض المنتجات",
  "catalog.products.create": "إضافة منتج",
  "catalog.products.update": "تعديل منتج",
  "catalog.products.delete": "حذف منتج",
  "catalog.categories.manage": "إدارة التصنيفات",
  "inventory.update": "تحديث المخزون",
  "orders.view": "عرض الطلبات",
  "orders.update": "تحديث الطلبات",
  "customers.view": "عرض العملاء",
  "customers.manage": "إضافة عميل يدوياً",
  // PG-2: three new codes, store_manager-only by role. A store_staff member must
  // not read the log that names whoever removed him, nor undo a removal — and
  // `catalog.trash.restore` is the ENTRY fee only: a coupon also needs
  // settings.manage and a team seat also needs team.manage (ح-3).
  "catalog.trash.view": "عرض سلة المحذوفات",
  "catalog.trash.restore": "استعادة من سلة المحذوفات",
  "catalog.audit.view": "عرض سجل النشاط",
  "pos.sell": "البيع على الكاشير",
  "team.manage": "إدارة الفريق",
  "settings.manage": "إدارة الإعدادات",
};
const PERMISSION_CODES = Object.keys(PERMISSION_LABELS) as StorePermissionCode[];
const ROLE_LABELS = { store_manager: "مدير متجر", store_staff: "موظف متجر" } as const;

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
    if (error.code === "STAFF_PERMISSION_DENIED") return "هذه الجلسة لا تملك صلاحية إدارة الفريق (403).";
    if (error.code === "EMAIL_RESERVED_FOR_PLATFORM_OWNER" || error.code === "DUPLICATE_IDENTITY") return "هذا البريد محجوز لهوية أخرى في المنصة ولا يمكن استخدامه لموظف.";
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "خطأ غير متوقع.";
}

function OverridesEditor({ membership, onSave, busy }: { membership: Membership; onSave: (overrides: Override[]) => Promise<void>; busy: boolean }) {
  const initial = new Map(membership.overrides.map((override) => [override.permissionCode, override.effect]));
  const [draft, setDraft] = useState<Map<string, "allow" | "deny">>(initial);

  return (
    <div className="mt-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4">
      <p className="mb-3 flex items-center gap-2 text-xs font-bold text-[#44526A]"><ShieldCheck className="h-4 w-4 text-[var(--codiq-accent)]" /> استثناءات الصلاحيات (سماح/منع فوق الدور)</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {PERMISSION_CODES.map((code) => {
          const value = draft.get(code) ?? "default";
          return (
            <label key={code} className="flex items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface)] px-3 py-2 text-xs font-semibold text-[#44526A] shadow-sm">
              <span>{PERMISSION_LABELS[code]}</span>
              <select
                data-testid={`override-${code}`}
                className="rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2 py-1 text-xs"
                value={value}
                onChange={(event) => {
                  const next = new Map(draft);
                  if (event.target.value === "default") next.delete(code);
                  else next.set(code, event.target.value as "allow" | "deny");
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
        data-testid="save-overrides"
        className="mt-3 rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]"
        onClick={() => onSave(Array.from(draft.entries()).map(([permissionCode, effect]) => ({ permissionCode, effect })))}
      >
        حفظ الاستثناءات
      </Button>
    </div>
  );
}

export function StoreTeamManager({ storeSlug }: { storeSlug?: string }) {
  const [team, setTeam] = useState<Membership[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [undo, setUndo] = useState<{ result: SoftDeleteResponse; label: string } | null>(null);
  // ق-228: the address belongs to a staff identity already — the merchant is
  // asked whether he means the same person before anyone is attached.
  const [linkCandidate, setLinkCandidate] = useState<{ email: string; displayName: string; temporaryPassword: string; roleCode: string } | null>(null);
  const teamUrl = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/team` : null;

  const load = useCallback(async () => {
    if (!teamUrl) return;
    try {
      const result = await api<{ team: Membership[] }>(teamUrl);
      setTeam(result.team);
      setFailure(null);
    } catch (error) {
      setTeam(null);
      setFailure(errorText(error));
    }
  }, [teamUrl]);

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

  /**
   * ق-228 — linking an EXISTING identity is a second, explicit act.
   *
   * The server refuses `STAFF_EMAIL_ALREADY_REGISTERED` when the address already
   * belongs to a live staff identity: one person genuinely does work in two
   * shops, but attaching him used to happen SILENTLY, so whoever typed an address
   * first won that person's identity. Here the merchant is shown what he is about
   * to do — and told plainly that the employee keeps his own password — and only
   * a deliberate confirmation sends `linkExisting`.
   */
  async function createMember(fields: { email: string; displayName: string; temporaryPassword: string; roleCode: string }, linkExisting: boolean) {
    if (!teamUrl) return;
    await api(teamUrl, {
      method: "POST",
      body: JSON.stringify({
        email: fields.email,
        // A person who already has an identity keeps his name and his password:
        // the server ignores both in that branch, and sending them would be this
        // shop trying to set another shop's employee's credentials.
        ...(linkExisting ? { linkExisting: true } : { displayName: fields.displayName, temporaryPassword: fields.temporaryPassword }),
        roleCode: fields.roleCode,
      }),
    });
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!teamUrl) return;
    const form = new FormData(event.currentTarget);
    const target = event.currentTarget;
    const fields = {
      email: String(form.get("email") ?? ""),
      displayName: String(form.get("displayName") ?? ""),
      temporaryPassword: String(form.get("temporaryPassword") ?? ""),
      roleCode: String(form.get("roleCode") ?? "store_staff"),
    };
    setLinkCandidate(null);
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      await createMember(fields, false);
      target.reset();
      setNotice("أُنشئ الموظف وأُسندت عضويته للمتجر الحالي. أرسل له رابط الدخول أدناه مع بريده وكلمة المرور المؤقتة.");
      await load();
    } catch (error) {
      // Not a failure — a question. He may genuinely be the same person.
      if (error instanceof ApiError && error.code === "STAFF_EMAIL_ALREADY_REGISTERED") setLinkCandidate(fields);
      else setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmLink() {
    if (!linkCandidate) return;
    const fields = linkCandidate;
    await run(async () => {
      await createMember(fields, true);
      setLinkCandidate(null);
    }, "رُبط الموظّف بمتجرك — يدخل بكلمة مروره هو، ولم تتغيّر.");
  }

  if (!storeSlug) {
    return <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 text-sm font-semibold text-[var(--codiq-danger)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]">افتح لوحة التاجر عبر مسار متجر محدد (store slug) قبل إدارة الفريق.</div>;
  }

  return (
    <div className="max-w-[1030px] space-y-5">
      {undo ? <UndoBar result={undo.result} label={undo.label} storeSlug={storeSlug} onUndone={() => { setUndo(null); void load(); setNotice("أُعيدت العضوية إلى الفريق. صلاحياته الخاصة عادت معه، وعليه تسجيل الدخول من جديد."); }} onDismiss={() => setUndo(null)} /> : null}
      {deleteTarget ? <DeleteConfirmSheet
        storeSlug={storeSlug}
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(result) => { setUndo({ result, label: deleteTarget.label }); void load(); }}
        onDeactivated={() => { void load(); setNotice("أُوقفت العضوية بدل إزالتها — الموظف يبقى في القائمة."); }}
      /> : null}
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UserPlus className="h-4 w-4" /> إنشاء موظف بكلمة مرور مؤقتة (D14-05)</p>
        <h2 className="mb-5 text-xl font-bold text-[#263650]">إضافة عضو إلى فريق المتجر الحالي</h2>
        <form onSubmit={submitCreate} className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]"><span>البريد الإلكتروني</span><Input data-testid="team-create-email" name="email" type="email" required /></label>
          <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]"><span>الاسم الظاهر</span><Input data-testid="team-create-name" name="displayName" required minLength={2} /></label>
          <div className="block space-y-1.5 text-sm font-semibold text-[#44526A]"><label htmlFor="team-create-password-field">كلمة مرور مؤقتة (8 خانات فأكثر)</label><PasswordInputWithMeter id="team-create-password-field" data-testid="team-create-password" name="temporaryPassword" required minLength={8} /></div>
          <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]"><span>الدور</span>
            <select data-testid="team-create-role" name="roleCode" required defaultValue="store_staff" className="h-9 w-full rounded-md border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 text-sm">
              <option value="store_staff">{ROLE_LABELS.store_staff}</option>
              <option value="store_manager">{ROLE_LABELS.store_manager}</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <Button data-testid="team-create-submit" disabled={busy} className="rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "إنشاء الموظف"}</Button>
          </div>
        </form>
        {/* ق-228: the address already belongs to someone on the platform. That is
            a question, not a failure — one person does work in two shops — but it
            is the merchant's to answer, not the server's to assume. */}
        {linkCandidate ? (
          <div data-testid="team-link-existing" className="mt-5 rounded-2xl border border-[var(--codiq-warning-border)] bg-[var(--codiq-warning-soft)] p-4">
            <p className="text-sm font-bold text-[var(--codiq-text)]">هذا البريد مسجَّل لموظّف على المنصّة</p>
            <p className="mt-1 text-sm leading-7 text-[var(--codiq-text-secondary)]">
              إن كان <span dir="ltr" className="font-bold">{linkCandidate.email}</span> هو الشخص نفسه، اربطه بمتجرك: يدخل <strong>بكلمة مروره هو</strong> ولن تتغيّر، ولن ترى أنت شيئاً من متاجره الأخرى. وإن لم يكن هو، اطلب منه بريداً يخصّه.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button data-testid="team-link-confirm" disabled={busy} onClick={() => void confirmLink()} className="rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "نعم، اربطه بمتجري"}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setLinkCandidate(null)} className="rounded-xl text-[var(--codiq-text-secondary)]">إلغاء</Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex items-center justify-between">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UsersRound className="h-4 w-4" /> أعضاء الفريق</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
        </div>
        {failure ? <p data-testid="team-error" className="mb-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
        {/* الموظف يصل بدعوة لا من الصفحة التعريفية (قرار المالك — رابط
            /staff/login حُذف منها)، فهذه هي الدعوة: التاجر ينسخها ويرسلها
            لموظفه على واتساب مع بريده وكلمة المرور المؤقتة. */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3 text-xs font-semibold text-[var(--codiq-accent-on-soft)]">
          <span>رابط دخول موظفيك:</span>
          <code dir="ltr" className="rounded-lg bg-[var(--codiq-surface)] px-2 py-1 font-bold">{`${window.location.origin}/staff/login`}</code>
          <button type="button" data-testid="team-copy-staff-link" className="rounded-lg border border-[var(--codiq-accent-on-soft)] px-2 py-1 font-bold transition hover:bg-[var(--codiq-surface)]" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/staff/login`).catch(() => {}); setNotice("نُسخ رابط الدخول — أرسله لموظفك."); }}>نسخ</button>
        </div>
        {notice ? <p data-testid="team-notice" className="mb-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
        {team === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p> : null}
        {/* ق-96: كان «أنشئي» — خطاب بالمؤنث في نص يقرأه التاجر، وهو مصدر الترجمة في P27-9. */}
        {team?.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا يوجد أعضاء بعد؛ أنشئ أول موظف من النموذج أعلاه.</p> : null}
        <div className="space-y-3">
          {team?.map((membership) => (
            <div key={membership.id} data-testid={`team-row-${membership.staff.email}`} className={`rounded-2xl border px-4 py-4 ${membership.isActive ? "border-[var(--codiq-border)] bg-[var(--codiq-surface)]" : "border-dashed border-[#E3B7BD] bg-[#FFF8F8]"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#263650]">{membership.staff.displayName}</p>
                  <p className="truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">{membership.staff.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid="team-role-select"
                    className="rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2 py-1.5 text-xs font-semibold"
                    value={membership.roleCode}
                    disabled={busy}
                    onChange={(event) => void run(async () => { await api(`${teamUrl}/${membership.id}`, { method: "PATCH", body: JSON.stringify({ roleCode: event.target.value }) }); }, "تغيّر الدور وأُبطلت جلسات العضوية المفتوحة فوراً.")}
                  >
                    <option value="store_staff">{ROLE_LABELS.store_staff}</option>
                    <option value="store_manager">{ROLE_LABELS.store_manager}</option>
                  </select>
                  <Button
                    size="sm"
                    variant={membership.isActive ? "outline" : "default"}
                    disabled={busy}
                    data-testid="team-active-toggle"
                    className={membership.isActive ? "rounded-xl border-[#E3B7BD] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]" : "rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[#1F5C41]"}
                    onClick={() => void run(async () => { await api(`${teamUrl}/${membership.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !membership.isActive }) }); }, membership.isActive ? "أُوقفت العضوية وأُبطلت جلساتها فوراً (D14-07). الموظف يبقى في القائمة." : "أُعيد تفعيل العضوية.")}
                  >
                    {membership.isActive ? "إيقاف" : "تفعيل"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="team-remove"
                    className="rounded-xl border-[#F0C7C4] text-[#B34B43] hover:bg-[#FFF7F7]"
                    onClick={() => { setNotice(null); setUndo(null); setDeleteTarget({ entityType: "staff_membership", id: membership.id, label: membership.staff.displayName, secondary: membership.staff.email }); }}
                  >
                    <UserMinus className="ml-1 h-3.5 w-3.5" />إزالة من الفريق
                  </Button>
                  <Button size="sm" variant="ghost" className="rounded-xl text-[var(--codiq-text-secondary)]" onClick={() => setExpanded(expanded === membership.id ? null : membership.id)}>
                    {expanded === membership.id ? "إخفاء الصلاحيات" : "الصلاحيات"}
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]">{ROLE_LABELS[membership.roleCode]}</span>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${membership.isActive ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`}>{membership.isActive ? "نشطة" : "موقوفة"}</span>
                {membership.permissions.map((permission) => (
                  <span key={permission} className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-semibold text-[#65748B]">{PERMISSION_LABELS[permission as StorePermissionCode] ?? permission}</span>
                ))}
              </div>
              {expanded === membership.id ? (
                <OverridesEditor
                  membership={membership}
                  busy={busy}
                  onSave={(overrides) => run(async () => { await api(`${teamUrl}/${membership.id}/overrides`, { method: "PUT", body: JSON.stringify({ overrides }) }); }, "حُفظت استثناءات الصلاحيات.")}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
