/**
 * codiq phase 19-أ — «الأمان» و«الجلسات والأجهزة»، لكل الهويات.
 *
 * The screens behind two nav entries that have been marked «قريباً — المرحلة 19»
 * since phase 14. Both APIs already shipped and had no interface at all:
 * `POST /auth/password` (PR #76) and the session routes (PR #74). An endpoint
 * nobody can reach is not a feature — this is the half that was missing.
 *
 * ONE COMPONENT, TWO VIEWS, because they are one subject: what protects this
 * account, and what is currently signed into it. Changing a password ends every
 * other session, so the two screens describe the same act from two sides, and a
 * person who has just changed his password should see the result rather than be
 * told about it.
 *
 * IT SERVES ALL FOUR IDENTITIES, exactly as the endpoints do — the token says
 * which kind it is and the server picks the right table. Nothing here is
 * merchant-specific, which is why it can hang under the owner, merchant and
 * staff dashboards from one file.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never renders a password back, never
 * stores one in state longer than the form lives, and does not offer «إنهاء كل
 * الجلسات» as a single button without naming the current one — a control that
 * signs you out while you are using it is a control people press once.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, LogOut, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrengthMeter } from "@/components/ui/password-strength-meter";
import { assessPassword } from "@/lib/password-strength";

type SessionView = {
  id: string;
  device: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  current: boolean;
};

const when = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : when.format(parsed);
}

/**
 * A user-agent string is not a device name. It is shown trimmed rather than
 * parsed: guessing «iPhone» from it is wrong often enough that a person would
 * stop trusting the list, and the list only has to answer one question — «is
 * anything here not me?»
 */
function deviceLabel(device: string | null): string {
  if (!device) return "جهاز غير معروف";
  return device.length > 72 ? `${device.slice(0, 72)}…` : device;
}

/**
 * Arabic counts do not work like English ones, and getting this wrong is exactly
 * the kind of thing that makes a platform feel translated rather than written.
 * The noun changes with the number: one and two have their own forms, three to
 * ten take the PLURAL, and eleven upwards returns to the singular.
 *
 * «أُنهيت 3 جلسة أخرى» is what a naive `${n} جلسة` produces, and it reads to an
 * Arabic speaker the way «3 session» reads to an English one.
 */
function endedSessionsPhrase(count: number): string {
  if (count === 1) return "جلسة أخرى واحدة";
  if (count === 2) return "جلستين أخريين";
  if (count <= 10) return `${count} جلسات أخرى`;
  return `${count} جلسة أخرى`;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error?.message ?? `فشل الطلب (${response.status})`;
}

export function AccountSecurityPanel({ view, onPasswordChanged }: { view: "password" | "sessions"; onPasswordChanged?: () => void }) {
  return view === "password" ? <ChangePasswordCard onChanged={onPasswordChanged} /> : <SessionsCard />;
}

function ChangePasswordCard({ onChanged }: { onChanged?: () => void } = {}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const assessment = assessPassword(newPassword);
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  // The button is disabled on what the CLIENT can be sure of. It is never the
  // authority — the server checks everything again — but letting somebody press
  // a button that cannot succeed wastes his time and teaches him the form lies.
  const ready = currentPassword.length > 0 && assessment.accepted && !mismatch && confirmPassword === newPassword;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setDone(body.otherSessionsEnded ?? 0);
      onChanged?.();
      // Cleared on success, never on failure: retyping a long password because
      // the CURRENT one was mistyped is its own small punishment.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[680px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <ShieldCheck className="h-4 w-4" /> أمان الحساب
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">تغيير كلمة المرور</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        عند التغيير تُنهى <strong>كل الجلسات الأخرى</strong> — أي جهاز آخر داخل على حسابك يخرج فوراً. جلستك الحالية تبقى، فلن تُخرَج من الجهاز الذي بين يديك.
      </p>
      {/* ق-218: a merchant whose first password was typed by whoever created his
          account lands here from the login itself. The rest of the dashboard is
          refused until this form is submitted, so the reason has to be on it. */}
      <p className="mb-6 rounded-2xl bg-[var(--codiq-warning-soft)] px-4 py-3 text-sm leading-7 text-[var(--codiq-text-secondary)]">
        إذا أنشأ حسابَك أحدٌ من فريق المنصة، فكلمة المرور الحالية <strong>يعرفها هو</strong>. غيّرها الآن لتصير لك وحدك — بقية اللوحة تُفتح فور تغييرها.
      </p>

      <form onSubmit={submit} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <label htmlFor="current-password" className="text-sm font-semibold text-[var(--codiq-text-secondary)]">
            كلمة المرور الحالية
          </label>
          <PasswordInput
            id="current-password"
            data-testid="current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="new-password" className="text-sm font-semibold text-[var(--codiq-text-secondary)]">
            كلمة المرور الجديدة
          </label>
          <PasswordInput
            id="new-password"
            data-testid="new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            aria-describedby="new-password-strength"
            required
          />
          <PasswordStrengthMeter value={newPassword} id="new-password-strength" />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="confirm-password" className="text-sm font-semibold text-[var(--codiq-text-secondary)]">
            تأكيد كلمة المرور الجديدة
          </label>
          <PasswordInput
            id="confirm-password"
            data-testid="confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
          {mismatch && (
            <p className="text-xs font-medium text-[var(--codiq-danger)]" data-testid="password-mismatch">
              الكلمتان غير متطابقتين.
            </p>
          )}
        </div>

        {failure && (
          <p
            data-testid="password-change-error"
            className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          >
            <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
          </p>
        )}
        {done !== null && (
          <p
            data-testid="password-change-done"
            className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          >
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {/* The count is stated because it is EVIDENCE. «تم التغيير» is a
                promise; «وأُنهيت 3 جلسات أخرى» is a fact he can check against
                the list on the next screen. */}
            تم تغيير كلمة المرور.{done > 0 ? ` وأُنهيت ${endedSessionsPhrase(done)}.` : " لم تكن هناك جلسات أخرى."}
          </p>
        )}

        <Button type="submit" disabled={busy || !ready} data-testid="password-change-submit" className="w-full rounded-xl py-6 text-base font-bold sm:w-auto sm:px-10">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تغيير كلمة المرور"}
        </Button>
      </form>
    </div>
  );
}

function SessionsCard() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/sessions", { credentials: "same-origin" });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setSessions((body.sessions ?? []) as SessionView[]);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      setSessions(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(label: string, request: () => Promise<Response>) {
    setBusy(label);
    setFailure(null);
    try {
      const response = await request();
      if (!response.ok) throw new Error(await readError(response));
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(null);
    }
  }

  const others = (sessions ?? []).filter((session) => !session.current).length;

  return (
    <div className="max-w-[860px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <MonitorSmartphone className="h-4 w-4" /> الجلسات والأجهزة
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">ما الذي يدخل إلى حسابك الآن</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        هذه القائمة تجيب على سؤال واحد: <strong>هل هنا شيء ليس أنت؟</strong> جلستك الحالية موسومة، كي لا تُنهيها بالخطأ.
      </p>

      {failure && (
        <p className="mb-5 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
        </p>
      )}

      {sessions === null ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
      ) : (
        <>
          <ul className="space-y-3" data-testid="session-list">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
                    <span className="truncate" dir="ltr">{deviceLabel(session.device)}</span>
                    {session.current && (
                      <span className="shrink-0 rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-accent-on-soft)]">
                        هذه الجلسة
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
                    آخر نشاط: {formatWhen(session.lastSeenAt)} · بدأت: {formatWhen(session.createdAt)}
                  </p>
                </div>
                {!session.current && (
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      act(session.id, () =>
                        fetch(`/api/auth/sessions/${session.id}`, { method: "DELETE", credentials: "same-origin" }),
                      )
                    }
                    className="shrink-0 rounded-xl"
                  >
                    {busy === session.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "إنهاء"}
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {others > 0 && (
            <Button
              variant="outline"
              disabled={busy !== null}
              data-testid="revoke-others"
              onClick={() =>
                act("others", () =>
                  fetch("/api/auth/sessions/revoke-others", { method: "POST", credentials: "same-origin" }),
                )
              }
              className="mt-6 gap-2 rounded-xl"
            >
              <LogOut className="h-4 w-4" />
              {/* Named, not «كل الجلسات»: a control that might sign you out
                  where you are standing is one people press once. */}
              إنهاء الجلسات الأخرى ({others})
            </Button>
          )}
        </>
      )}
    </div>
  );
}
