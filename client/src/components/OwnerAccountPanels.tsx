/**
 * PC-1 — «حسابي ومعلومات التواصل»، الجانب الذي يراه مالك المنصة.
 *
 * The owner asked for buttons, not for values: «اذا تم اضافه زر تغيير كلمة السر
 * و الايميل و رقم التواصل و كافه معلومات التواصل في لوحة المالك». So these two
 * cards exist to end a category of work rather than to do one job once — after
 * them, a new phone number is a form he fills in, and never again a pull request.
 *
 * PS-2 later added a THIRD card, `OwnerTotpCard`, to the same file and the same
 * «الأمان» page — its own head comment says why it had to exist at all.
 *
 * THE CARDS ARE KEPT APART DELIBERATELY:
 *
 *   · `OwnerEmailCard` changes HIS OWN sign-in address. It re-authenticates,
 *     because changing the address a reset link would be sent to IS the account
 *     takeover, and a live session is exactly what a borrowed laptop already has.
 *     It sits beside the existing password card under «الأمان» — the two acts a
 *     man performs on his own identity, in one place.
 *
 *   · `PlatformContactCard` changes what the WORLD is told. Nothing about it is
 *     personal and nothing about it is secret, so it asks for no password and
 *     lives on its own page under «معلومات التواصل».
 *
 * The password card is NOT rebuilt here. It shipped in 19-أ
 * (`AccountSecurityPanel view="password"`) and is rendered beside this one by
 * `OwnerDashboard`; a second copy would be a second place to fix the next bug.
 */
import { useCallback, useEffect, useState } from "react";
import { AtSign, CircleAlert, KeyRound, LoaderCircle, Phone, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { formatContactPhone } from "@/lib/platform-contact";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

/**
 * A Latin value — an address, a phone — inside an Arabic sentence, isolated so
 * the bidi algorithm cannot reorder it against the text around it.
 *
 * Without this, «تعرض (LRM)+964 770 123 4567.» renders with the full stop dragged
 * into the middle of the number and the last group wrapped to the next line: the
 * number becomes unreadable at exactly the moment it is being shown as proof of
 * what was saved. U+2068/U+2069 are the characters this problem was invented for
 * — `dir="ltr"` on an element cannot help a value spliced into a template string.
 */
const ltr = (value: string) => `\u2068${value}\u2069`;

const CARD = "max-w-[680px] rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9";
const LABEL = "text-sm font-semibold text-[var(--codiq-text-secondary)]";
const NOTE = "text-xs leading-6 text-[var(--codiq-text-muted)]";
const EYEBROW = "mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]";
const SUNKEN = "rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3";

const when = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });
const digits = new Intl.NumberFormat("ar-IQ");

function Failure({ message, testId }: { message: string; testId: string }) {
  return (
    <p data-testid={testId} className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
      <CircleAlert className="h-4 w-4 shrink-0" /> {message}
    </p>
  );
}

function Done({ message, testId }: { message: string; testId: string }) {
  return (
    <p data-testid={testId} className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">
      <ShieldCheck className="h-4 w-4 shrink-0" /> {message}
    </p>
  );
}

/**
 * PS-2 — 19-أ's second factor, reachable at last (ق-124).
 *
 * The routes, the service, the migration and the integration test all shipped in
 * 19-أ, and `DashboardLogin` has accepted a code at the owner door ever since.
 * Nothing ever CALLED the enrolment routes. Platform staff got a mandatory
 * enrolment screen that blocks their whole shell; the owner — the one identity
 * with nobody above him to restore access — got no surface at all. So ق-124
 * required of him a factor the interface made impossible to turn on, and it
 * stayed impossible from the day it shipped until he opened «الأمان» on the live
 * platform and found two cards where three belonged.
 *
 * THE RECOVERY CODES ARE WHY THIS IS NOT THE STAFF SCREEN COPIED.
 * `confirmTotpEnrolment` returns ten codes in the clear exactly once and hashes
 * them before it returns; `PlatformStaffDashboard` discards that body on purpose,
 * because a member who loses his phone has an owner who can reset him. The owner
 * has no one. If this card ever fails to put those ten codes in front of him, a
 * lost phone ends the platform — so they are a BLOCKING step he has to
 * acknowledge, never a toast beside a redirect, and nothing refetches while they
 * are on screen.
 *
 * THE QR IS GENERATED IN THE BROWSER AND NOWHERE ELSE. The otpauth URI carries
 * the TOTP secret in the clear — that is what it is for — so handing it to any
 * image service would post the second factor of the account that owns the whole
 * platform to a third party. `qrcode` is imported dynamically, so it costs
 * nothing until the moment enrolment begins.
 *
 * 19-ب's «no QR library» ruling is superseded HERE ONLY, and by the owner asking
 * for it: «هل تستطيع جعله باركود يقرئه البرنامج الخاص بالمصادقه مباشرة». It
 * stands for the staff screen, which is a different surface with a different
 * cost. And the key and link stay on screen beside the QR rather than being
 * replaced by it — so a camera that will not focus, a reader that rejects the
 * image, or an encoder that throws leaves the owner typing fifteen characters
 * instead of locked out of enrolling at all.
 */
export function OwnerTotpCard() {
  const [status, setStatus] = useState<{ enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number } | null>(null);
  const [material, setMaterial] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [disarming, setDisarming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ totp: { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number } }>("/api/platform/security/totp");
      setStatus(result.totp);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The QR, drawn from the URI the SERVER minted — never re-derived here, so the
  // image and the key below it can never disagree. No colour options are passed:
  // the encoder bakes its own white quiet zone into the PNG, which is what keeps
  // it scannable on a dark theme without this file naming a single raw colour.
  // A failure is silent ON PURPOSE — the key and the link are already on screen,
  // and an error box for a convenience that has a working fallback beside it
  // only teaches the owner to distrust a card that is doing its job.
  useEffect(() => {
    if (!material) { setQr(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const { toDataURL } = await import("qrcode");
        const url = await toDataURL(material.uri, { errorCorrectionLevel: "M", margin: 2, width: 232 });
        if (!cancelled) setQr(url);
      } catch {
        if (!cancelled) setQr(null);
      }
    })();
    return () => { cancelled = true; };
  }, [material]);

  // `navigator.clipboard` is absent over plain http and can be refused by
  // permission, so every value it copies is ALSO rendered selectable on screen.
  // A copy button that silently does nothing is how recovery codes get lost.
  function copy(value: string, copied: string) {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setNotice(copied);
  }

  async function begin() {
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      setMaterial(await api<{ secret: string; uri: string }>("/api/platform/security/totp/begin", { method: "POST" }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>("/api/platform/security/totp/confirm", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      // Held in state and rendered exclusively below: `load()` is NOT called here,
      // because a refetch that re-rendered this card would take the only copy of
      // these ten strings that will ever exist away from the man reading them.
      setCodes(result.recoveryCodes);
      setMaterial(null);
      setCode("");
      setNotice(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      await api<null>("/api/platform/security/totp/disable", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      setDisarming(false);
      setDone("عُطّلت المصادقة الثنائية وحُذفت رموز الاستعادة. حسابك الآن بكلمة مرور واحدة.");
      void load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <div className={CARD} data-testid="owner-totp-codes">
        <p className={EYEBROW}><KeyRound className="h-4 w-4" /> رموز الاستعادة</p>
        <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">احفظ هذه الرموز الآن — لن تظهر مرة أخرى</h2>
        <p className="mb-5 text-sm leading-7 text-[var(--codiq-text-muted)]">
          فُعّلت المصادقة الثنائية. كل رمز من هذه العشرة يدخلك <strong>مرة واحدة</strong> إذا فقدت هاتفك، ثم يُستهلك. أنت مالك المنصة ولا أحد فوقك يعيد لك الوصول — هذه الرموز هي طريقك الوحيد للعودة.
        </p>
        <ol data-testid="owner-totp-code-list" dir="ltr" className="grid gap-2 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 sm:grid-cols-2">
          {codes.map((value) => (
            <li key={value} className="select-all rounded-lg bg-[var(--codiq-surface)] px-3 py-2 text-center font-mono text-sm font-bold tracking-wider text-[var(--codiq-text)]">{value}</li>
          ))}
        </ol>
        <p className={`mt-4 ${NOTE}`}>اكتبها على ورق أو ضعها في مدير كلمات مرور. لا تتركها في الهاتف نفسه الذي يحمل تطبيق المصادقة — ضياعه عندها يضيّع الاثنين معاً.</p>
        {notice ? <div className="mt-4"><Done message={notice} testId="owner-totp-notice" /></div> : null}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Button type="button" variant="outline" data-testid="owner-totp-copy-codes" onClick={() => copy(codes.join("\n"), "نُسخت الرموز العشرة — الصقها في مكانها الآمن قبل أن تنسخ أي شيء آخر.")} className="rounded-xl py-6 text-base font-bold">
            نسخ الرموز العشرة
          </Button>
          <Button type="button" data-testid="owner-totp-codes-ack" onClick={() => { setCodes(null); setNotice(null); setDone("فُعّلت المصادقة الثنائية. من الآن يطلب الدخول رمزاً من تطبيق المصادقة بعد كلمة المرور."); void load(); }} className="rounded-xl py-6 text-base font-bold sm:px-10">
            حفظتُها في مكان آمن
          </Button>
        </div>
      </div>
    );
  }

  const enabled = status?.enabled === true;
  const left = status?.recoveryCodesLeft ?? 0;

  return (
    <div className={CARD}>
      <p className={EYEBROW}>
        {enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />} المصادقة الثنائية
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">طبقة ثانية على حسابك</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        هذا الحساب يفتح المنصة كلها ولا أحد فوقه. عند التفعيل يطلب الدخول <strong>رمزاً متغيّراً</strong> من تطبيق مصادقة على هاتفك بعد كلمة المرور، فلا تكفي سرقة كلمة المرور وحدها.
      </p>

      {status === null && !failure ? <p className={NOTE}><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}

      {status ? (
        <div className={`mb-6 ${SUNKEN}`}>
          <p className={NOTE}>الحالة</p>
          <p className="mt-0.5 text-sm font-bold text-[var(--codiq-text)]" data-testid="owner-totp-state">
            {enabled ? `مفعّلة${status.enabledAt ? ` منذ ${when.format(new Date(status.enabledAt))}` : ""}` : "غير مفعّلة — كلمة مرورك وحدها تفتح لوحة المنصة"}
          </p>
          {enabled ? <p className={`mt-1 ${NOTE}`} data-testid="owner-totp-codes-left">رموز الاستعادة المتبقية: {digits.format(left)} من {digits.format(10)}</p> : null}
        </div>
      ) : null}

      {enabled && left === 0 ? (
        <div className="mb-6"><Failure message="لم يبق لك أي رمز استعادة. إن فقدت هاتفك الآن فلا سبيل للعودة — عطّل المصادقة بكلمة مرورك ثم أعد تفعيلها، فتُولَّد عشرة رموز جديدة." testId="owner-totp-codes-exhausted" /></div>
      ) : null}

      {failure ? <div className="mb-6"><Failure message={failure} testId="owner-totp-error" /></div> : null}
      {done ? <div className="mb-6"><Done message={done} testId="owner-totp-done" /></div> : null}
      {notice ? <div className="mb-6"><Done message={notice} testId="owner-totp-notice" /></div> : null}

      {status && !enabled && !material ? (
        <Button type="button" onClick={() => void begin()} disabled={busy} data-testid="owner-totp-begin" className="w-full rounded-xl py-6 text-base font-bold sm:w-auto sm:px-10">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "ابدأ التفعيل"}
        </Button>
      ) : null}

      {material ? (
        <>
          {qr ? (
            <figure className="mb-5 flex flex-col items-center gap-2">
              <img src={qr} alt="رمز QR يحمل مفتاح المصادقة الثنائية — امسحه بتطبيق المصادقة" data-testid="owner-totp-qr" width={232} height={232} className="rounded-2xl border border-[var(--codiq-border)]" />
              <figcaption className={NOTE}>افتح تطبيق المصادقة واختر «مسح رمز QR» ووجّه الكاميرا إلى هذه الصورة — يملأ كل شيء بنفسه.</figcaption>
            </figure>
          ) : null}
          <div className="space-y-3">
            <div className={SUNKEN}>
              <p className="mb-1 text-xs font-bold text-[var(--codiq-text-secondary)]">المفتاح السري</p>
              <div className="flex flex-wrap items-center gap-2">
                <code data-testid="owner-totp-secret" dir="ltr" className="select-all break-all rounded-lg bg-[var(--codiq-surface)] px-2 py-1 font-mono text-sm font-bold tracking-wider text-[var(--codiq-text)]">{material.secret}</code>
                <button type="button" data-testid="owner-totp-copy-secret" className="rounded-lg border border-[var(--codiq-border)] px-2 py-1 text-xs font-bold text-[var(--codiq-text-secondary)] transition hover:bg-[var(--codiq-surface)]" onClick={() => copy(material.secret, "نُسخ المفتاح — الصقه في تطبيق المصادقة.")}>نسخ</button>
              </div>
            </div>
            <div className={SUNKEN}>
              <p className="mb-1 text-xs font-bold text-[var(--codiq-text-secondary)]">رابط otpauth (للتطبيقات التي تقبل لصق الرابط)</p>
              <div className="flex flex-wrap items-center gap-2">
                <code dir="ltr" className="select-all break-all rounded-lg bg-[var(--codiq-surface)] px-2 py-1 font-mono text-[11px] text-[var(--codiq-text-secondary)]">{material.uri}</code>
                <button type="button" data-testid="owner-totp-copy-uri" className="rounded-lg border border-[var(--codiq-border)] px-2 py-1 text-xs font-bold text-[var(--codiq-text-secondary)] transition hover:bg-[var(--codiq-surface)]" onClick={() => copy(material.uri, "نُسخ الرابط — الصقه في تطبيق المصادقة.")}>نسخ</button>
              </div>
            </div>
          </div>
          <p className={`mt-3 ${NOTE}`}>
            {qr ? "وإن تعذّر المسح، أضف المفتاح يدوياً" : "أضف المفتاح إلى تطبيق مصادقة على هاتفك (Google Authenticator أو ما يماثله)"} — واختر <strong>«الاستناد للوقت»</strong> لا «الاستناد للعدد»، فالخادم يحسب الرمز من الساعة. ستّ خانات، تتجدّد كل ثلاثين ثانية. ولا شيء يُفعَّل قبل أن يثبت الرمز أن التطبيق يعمل.
          </p>
          <form onSubmit={confirm} className="mt-5 space-y-5" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="owner-totp-code" className={LABEL}>الرمز الظاهر في التطبيق الآن</label>
              <Input id="owner-totp-code" data-testid="owner-totp-code" dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
            </div>
            <Button type="submit" disabled={busy || code.trim().length === 0} data-testid="owner-totp-confirm" className="w-full rounded-xl py-6 text-base font-bold sm:w-auto sm:px-10">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تأكيد التفعيل"}
            </Button>
          </form>
        </>
      ) : null}

      {enabled && !disarming ? (
        <button type="button" data-testid="owner-totp-disarm" onClick={() => { setDisarming(true); setDone(null); setNotice(null); }} className="text-sm font-bold text-[var(--codiq-text-secondary)] underline underline-offset-4 transition hover:text-[var(--codiq-danger)]">
          تعطيل المصادقة الثنائية
        </button>
      ) : null}

      {enabled && disarming ? (
        // The password, not merely a live session: a borrowed unlocked laptop is
        // exactly the case the factor exists for. `disableTotp` enforces this
        // server-side and rate-limits the attempts; the form only asks honestly.
        <form onSubmit={disable} className="space-y-5" noValidate>
          <p className={NOTE}>التعطيل يمحو رموز الاستعادة العشرة أيضاً، ويعيد حسابك إلى كلمة مرور واحدة. لربط هاتف آخر، عطّل ثم فعّل من جديد.</p>
          <div className="space-y-1.5">
            <label htmlFor="owner-totp-password" className={LABEL}>كلمة مرورك الحالية</label>
            <PasswordInput id="owner-totp-password" data-testid="owner-totp-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="submit" variant="destructive" disabled={busy || password.length === 0} data-testid="owner-totp-disable" className="rounded-xl py-6 text-base font-bold sm:px-10">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تعطيل المصادقة"}
            </Button>
            <Button type="button" variant="outline" onClick={() => { setDisarming(false); setPassword(""); }} className="rounded-xl py-6 text-base font-bold">
              تراجع
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** The owner's own sign-in email. Re-authenticated; the password is untouched. */
export function OwnerEmailCard() {
  const [current, setCurrent] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ account: { email: string } }>("/api/platform/security/account");
      setCurrent(result.account.email);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const result = await api<{ email: string }>("/api/platform/security/email", { method: "POST", body: JSON.stringify({ currentPassword: password, email }) });
      setCurrent(result.email);
      setDone(`صار بريد دخولك ${ltr(result.email)} — كلمة المرور لم تتغير، وجلستك الحالية مستمرة.`);
      setEmail("");
      // Cleared on success only: retyping a password because the EMAIL was
      // mistyped is a punishment for the wrong mistake.
      setPassword("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={CARD}>
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <AtSign className="h-4 w-4" /> بريد الدخول
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">تغيير بريدك الإلكتروني</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        هذا هو البريد الذي تدخل به إلى لوحة المالك. تغييره <strong>لا يغيّر كلمة مرورك</strong> ولا يُخرجك من جلستك — لكنه يطلب كلمة مرورك الحالية، لأن من يملك تغيير بريدك يملك حسابك.
      </p>

      <div className="mb-6 rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3">
        <p className={NOTE}>بريدك الحالي</p>
        <p className="mt-0.5 text-sm font-bold text-[var(--codiq-text)]" dir="ltr" data-testid="owner-current-email">{current ?? "…"}</p>
      </div>

      <form onSubmit={submit} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <label htmlFor="owner-new-email" className={LABEL}>البريد الجديد</label>
          <Input id="owner-new-email" data-testid="owner-new-email" type="email" autoComplete="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="owner-email-password" className={LABEL}>كلمة مرورك الحالية</label>
          <PasswordInput id="owner-email-password" data-testid="owner-email-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>

        {failure ? <Failure message={failure} testId="owner-email-error" /> : null}
        {done ? <Done message={done} testId="owner-email-done" /> : null}

        <Button type="submit" disabled={busy || email.trim().length === 0 || password.length === 0} data-testid="owner-email-submit" className="w-full rounded-xl py-6 text-base font-bold sm:w-auto sm:px-10">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تغيير البريد"}
        </Button>
      </form>
    </div>
  );
}

/** The platform's PUBLIC contact details — what the landing page's footer shows. */
export function PlatformContactCard() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ contact: { email: string; phone: string; whatsapp: string; whatsappIsSeparate: boolean } }>("/api/platform/settings/contact");
      setEmail(result.contact.email);
      setPhone(result.contact.phone);
      // An empty box means «واتساب على رقم التواصل نفسه» — so a WhatsApp number
      // that merely FOLLOWS the phone must arrive empty, not prefilled with a
      // copy that would freeze it the next time the phone changes.
      setWhatsapp(result.contact.whatsappIsSeparate ? result.contact.whatsapp : "");
      setLoaded(true);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const result = await api<{ contact: { email: string; phone: string; whatsapp: string; whatsappIsSeparate: boolean } }>("/api/platform/settings/contact", {
        method: "PUT",
        body: JSON.stringify({ email, phone, whatsapp: whatsapp.trim() || null }),
      });
      setEmail(result.contact.email);
      setPhone(result.contact.phone);
      setWhatsapp(result.contact.whatsappIsSeparate ? result.contact.whatsapp : "");
      setDone(`حُفظت معلومات التواصل — الصفحة التعريفية تعرض ${ltr(result.contact.email)} و${ltr(formatContactPhone(result.contact.phone))}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={CARD}>
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <Phone className="h-4 w-4" /> معلومات التواصل
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">ما تعرضه المنصة للعالم</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        هذه هي القنوات المنشورة في تذييل الصفحة التعريفية. ما تحفظه هنا يظهر للزوار مباشرة — <strong>ليست بريد دخولك ولا كلمة مرورك</strong>، وتغييرها لا يمس حسابك.
      </p>

      {!loaded && !failure ? <p className={NOTE}><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}

      {loaded ? (
        <form onSubmit={submit} className="space-y-5" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="contact-email" className={LABEL}>بريد التواصل</label>
            <Input id="contact-email" data-testid="contact-email" type="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="contact-phone" className={LABEL}>رقم التواصل</label>
            <Input id="contact-phone" data-testid="contact-phone" type="tel" dir="ltr" value={phone} onChange={(event) => setPhone(event.target.value)} required />
            <p className={NOTE}>اكتبه بصيغة 07XXXXXXXXX أو {"\u200E"}+9647XXXXXXXXX — كلاهما مقبول ويُحفظ بالصيغة الدولية.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="contact-whatsapp" className={LABEL}>رقم واتساب <span className="font-normal text-[var(--codiq-text-muted)]">(اختياري)</span></label>
            <Input id="contact-whatsapp" data-testid="contact-whatsapp" type="tel" dir="ltr" value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} placeholder="اتركه فارغاً" />
            <p className={NOTE}>اتركه فارغاً إذا كان واتساب على رقم التواصل نفسه — عندها يتبعه تلقائياً كلما غيّرته.</p>
          </div>

          {failure ? <Failure message={failure} testId="contact-error" /> : null}
          {done ? <Done message={done} testId="contact-done" /> : null}

          <Button type="submit" disabled={busy || email.trim().length === 0 || phone.trim().length === 0} data-testid="contact-submit" className="w-full rounded-xl py-6 text-base font-bold sm:w-auto sm:px-10">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "حفظ معلومات التواصل"}
          </Button>
        </form>
      ) : null}

      {!loaded && failure ? <Failure message={failure} testId="contact-error" /> : null}
    </div>
  );
}
