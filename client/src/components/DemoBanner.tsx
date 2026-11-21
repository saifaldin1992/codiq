/**
 * codiq P27-7 — demo-environment banner.
 *
 * Reads the flag from the server (`GET /api/public/demo-status`) instead of
 * guessing from the hostname, so it is right in every environment and can never
 * contradict what the server actually enforces. Renders nothing at all outside
 * the demo environment, and nothing until the answer arrives — so no other
 * environment ever flashes a banner.
 *
 * Design: One UI — slim, calm, vector-only icon, RTL, dismissible for the
 * session (sessionStorage, so the next visit shows it again).
 */
import { useEffect, useState } from "react";
import { FlaskConical, X } from "lucide-react";

const DISMISS_KEY = "codiq_demo_banner_dismissed";
export const DEMO_BANNER_TEXT =
  "نسخة تجريبية من Codiq — البيانات تُعاد كل ليلة، ولا تُرسل رسائل حقيقية";

/** Module-level cache: the shells mount three banners across a session; ask once. */
let demoStatusPromise: Promise<boolean> | null = null;

function fetchDemoStatus(): Promise<boolean> {
  demoStatusPromise ??= fetch("/api/public/demo-status", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : { demo: false }))
    .then((payload: { demo?: unknown }) => payload?.demo === true)
    .catch(() => false);
  return demoStatusPromise;
}

/** `null` while unknown; the banner and the guest-entry page both wait on it. */
export function useDemoMode(): boolean | null {
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void fetchDemoStatus().then((value) => {
      if (active) setDemo(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return demo;
}

function sessionDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function DemoBanner() {
  const demo = useDemoMode();
  const [dismissed, setDismissed] = useState(() => sessionDismissed());
  if (demo !== true || dismissed) return null;
  return (
    <div
      dir="rtl"
      role="status"
      data-testid="demo-banner"
      className="flex items-center justify-between gap-3 border-b border-[#D9E6FA] bg-[var(--codiq-accent-soft)] px-4 py-2 text-[#1B4E96] sm:px-6"
    >
      <p className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold leading-5">
        <FlaskConical className="h-4 w-4 shrink-0" strokeWidth={1.9} aria-hidden="true" />
        <span className="truncate sm:whitespace-normal">{DEMO_BANNER_TEXT}</span>
      </p>
      <button
        type="button"
        aria-label="إخفاء إشعار النسخة التجريبية"
        onClick={() => {
          setDismissed(true);
          try {
            window.sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* private mode: hide for this render only */
          }
        }}
        className="shrink-0 rounded-lg p-1 text-[#4A79C4] transition-colors hover:bg-white/70 hover:text-[#1B4E96]"
      >
        <X className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  );
}
