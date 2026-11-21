/**
 * codiq P27-7 — one-click guest entry, the link the owner sends to a prospect:
 * https://<demo-host>/demo
 *
 * Posts to the demo-only endpoint and follows the server's redirect into the
 * seeded merchant dashboard. It holds no credentials and grants nothing by
 * itself: the session is minted server-side and only when CODIQ_DEMO_MODE is on
 * (the route is not even registered otherwise, which is why a non-demo host
 * lands on the "not a demo environment" state below).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { useDemoMode } from "@/components/DemoBanner";

export default function DemoEntryPage() {
  const [, navigate] = useLocation();
  const demo = useDemoMode();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (demo !== true || started.current) return;
    started.current = true;
    fetch("/api/public/demo-login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? "تعذّر بدء الجولة التجريبية.");
        navigate(payload.redirectTo);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "تعذّر بدء الجولة التجريبية.")
      );
  }, [demo, navigate]);

  const notDemo = demo === false;
  return (
    <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
      <div className="w-full max-w-md rounded-[28px] bg-[var(--codiq-surface)] p-8 text-center shadow-[0_16px_44px_rgba(31,55,98,0.08)]">
        <BrandMark className="mx-auto h-12 w-12 rounded-2xl shadow-[0_8px_18px_rgba(30,111,219,0.22)]" />
        <h1 className="mt-4 text-2xl font-bold text-[var(--codiq-text)]">
          الجولة التجريبية في Codiq
        </h1>
        {notDemo || error ? (
          <>
            <p className="mt-3 flex items-center justify-center gap-2 text-sm leading-6 text-[var(--codiq-danger)]">
              <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={1.9} />
              {notDemo ? "هذه ليست بيئة النسخة التجريبية." : error}
            </p>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="mt-6 w-full rounded-xl bg-[var(--codiq-accent)] px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[var(--codiq-accent-hover)]"
            >
              العودة إلى الصفحة الرئيسية
            </button>
          </>
        ) : (
          <p className="mt-3 flex items-center justify-center gap-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
            <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={2} />
            جارٍ تجهيز متجرك التجريبي…
          </p>
        )}
      </div>
    </main>
  );
}
