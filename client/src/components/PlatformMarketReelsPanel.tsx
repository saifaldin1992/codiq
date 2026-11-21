/**
 * «مراجعة الريلز» — the owner watches each store's video before it reaches the
 * market and approves it, or rejects it with a reason the store sees.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type QueueReel = {
  id: string;
  caption: string | null;
  status: string;
  decisionNote: string | null;
  createdAt: string;
  videoByteSize: number;
  store: { slug: string; name: string };
  product: { id: string; name: string } | null;
};
const TABS = [
  ["pending", "بانتظار المراجعة"],
  ["approved", "منشورة"],
  ["rejected", "مرفوضة"],
] as const;
const card =
  "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function PlatformMarketReelsPanel() {
  const [status, setStatus] = useState<(typeof TABS)[number][0]>("pending");
  const [reels, setReels] = useState<QueueReel[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReels(
        (await call<{ reels: QueueReel[] }>(`/api/platform/market/reels?status=${status}&limit=30`))
          .reels
      );
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, [status]);
  useEffect(() => {
    setReels(null);
    void load();
  }, [load]);
  async function decide(reel: QueueReel, approve: boolean) {
    try {
      await call(`/api/platform/market/reels/${reel.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ approve, note: notes[reel.id] || undefined }),
      });
      setNotice(approve ? "نُشر الفيديو في السوق." : "رُفض الفيديو وأُبلغ المتجر بالسبب.");
      setFailure(null);
      await load();
    } catch (error) {
      setFailure((error as Error).message);
      setNotice(null);
    }
  }
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-reels">
      {failure ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          data-testid="platform-reels-error"
        >
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          data-testid="platform-reels-notice"
        >
          <CircleCheck className="h-4 w-4" /> {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {TABS.map(([value, label]) => (
          <Button
            key={value}
            type="button"
            variant={status === value ? "default" : "outline"}
            onClick={() => setStatus(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {!reels ? (
        <LoaderCircle className="h-5 w-5 animate-spin" />
      ) : !reels.length ? (
        <p className="text-sm text-[var(--codiq-text-muted)]" data-testid="platform-reels-empty">
          لا فيديوهات هنا.
        </p>
      ) : (
        reels.map((reel) => (
          <section key={reel.id} className={card} data-testid="platform-reel-row">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-black text-[var(--codiq-text)]">{reel.store.name}</h3>
              <span className="text-xs text-[var(--codiq-text-muted)]">
                {new Date(reel.createdAt).toLocaleString("ar-IQ", { timeZone: "Asia/Baghdad" })} ·{" "}
                {(reel.videoByteSize / 1048576).toFixed(1)} MB
              </span>
            </div>
            {reel.caption ? (
              <p className="text-sm text-[var(--codiq-text)]">{reel.caption}</p>
            ) : null}
            {reel.product ? (
              <p className="text-xs text-[var(--codiq-text-secondary)]">
                المنتج: {reel.product.name}
              </p>
            ) : null}
            <video
              src={`/api/platform/market/reels/${encodeURIComponent(reel.id)}/video`}
              controls
              playsInline
              preload="metadata"
              className="max-h-96 rounded-2xl bg-[var(--codiq-text)]"
            />
            {reel.decisionNote ? (
              <p className="text-xs text-[var(--codiq-text-secondary)]">
                ملاحظة: {reel.decisionNote}
              </p>
            ) : null}
            {reel.status === "pending" ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={notes[reel.id] ?? ""}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [reel.id]: event.target.value }))
                  }
                  placeholder="سبب الرفض (يراه المتجر)"
                  maxLength={300}
                  className="min-w-[220px] flex-1 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm"
                  data-testid="platform-reel-note"
                />
                <Button
                  type="button"
                  onClick={() => void decide(reel, true)}
                  data-testid="platform-reel-approve"
                >
                  موافقة ونشر
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void decide(reel, false)}
                  data-testid="platform-reel-reject"
                >
                  رفض
                </Button>
              </div>
            ) : reel.status === "approved" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void decide(reel, false)}
                disabled={!notes[reel.id]}
                title="اكتب السبب أولاً"
              >
                إيقاف النشر
              </Button>
            ) : null}
            {reel.status === "approved" ? (
              <input
                value={notes[reel.id] ?? ""}
                onChange={(event) =>
                  setNotes((current) => ({ ...current, [reel.id]: event.target.value }))
                }
                placeholder="سبب الإيقاف"
                maxLength={300}
                className="w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm"
              />
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}
