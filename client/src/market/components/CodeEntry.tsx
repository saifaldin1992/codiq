/** Six digits, with the «resend in N seconds» clock; the phone's keyboard offers the SMS code itself. */
import { useEffect, useState } from "react";

export function CodeEntry({
  value,
  onChange,
  resendAt,
  onResend,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  resendAt: number;
  onResend: () => void;
  testId: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  return (
    <div className="space-y-2">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="••••••"
        dir="ltr"
        className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 text-center text-2xl font-black tracking-[0.5em] text-[var(--codiq-text)]"
        data-testid={testId}
        aria-label="رمز التحقق"
      />
      <p className="text-center text-xs text-[var(--codiq-text-muted)]">
        {wait > 0 ? (
          <>إعادة الإرسال خلال {wait.toLocaleString("ar-IQ")} ثانية</>
        ) : (
          <button type="button" onClick={onResend} className="font-bold text-[var(--codiq-accent)]">
            إعادة إرسال الرمز
          </button>
        )}
      </p>
    </div>
  );
}
