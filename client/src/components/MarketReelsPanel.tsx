/**
 * «ريلز» — the store's short videos for the market: upload one (MP4/WebM/MOV,
 * 30MB at most) with an optional cover and product, follow its review, preview
 * it, take it down. Nothing is public until the market approves it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Clapperboard, LoaderCircle, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

type Reel = { id: string; caption: string | null; status: string; decisionNote: string | null; viewCount: number; likeCount: number; createdAt: string; product: { id: string; name: string } | null };
type Product = { id: string; name: string };
const STATUS: Record<string, string> = { pending: "بانتظار مراجعة السوق", approved: "منشور", rejected: "مرفوض" };
const input = "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
const card = "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function MarketReelsPanel({ storeSlug }: { storeSlug?: string }) {
  const slug = encodeURIComponent(storeSlug ?? "");
  const [reels, setReels] = useState<Reel[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    try { setReels((await call<{ reels: Reel[] }>(`/api/merchant/stores/${slug}/market-reels?limit=50`)).reels); } catch (error) { setFailure((error as Error).message); }
  }, [slug]);
  useEffect(() => {
    void load();
    void call<{ products: Product[] }>(`/api/merchant/stores/${slug}/market-catalog/products?limit=100`).then((body) => setProducts(body.products)).catch(() => undefined);
  }, [load, slug]);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const data = new FormData(element);
    if (!(data.get("video") instanceof File) || !(data.get("video") as File).size) { setFailure("اختر ملفّ الفيديو."); return; }
    if (!(data.get("poster") as File | null)?.size) data.delete("poster");
    setUploading(true);
    try {
      await call(`/api/merchant/stores/${slug}/market-reels`, { method: "POST", body: data });
      element.reset();
      setNotice("أُرسل الفيديو لمراجعة السوق — يظهر للمتسوّقين بعد الموافقة."); setFailure(null); await load();
    } catch (error) { setFailure((error as Error).message); setNotice(null); } finally { setUploading(false); }
  }
  async function remove(reel: Reel) {
    try { await call(`/api/merchant/stores/${slug}/market-reels/${reel.id}`, { method: "DELETE" }); setNotice("حُذف الفيديو."); setFailure(null); if (preview === reel.id) setPreview(null); await load(); } catch (error) { setFailure((error as Error).message); setNotice(null); }
  }

  return (
    <div className="max-w-[1030px] space-y-4" data-testid="merchant-market-reels">
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="merchant-reels-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]" data-testid="merchant-reels-notice"><CircleCheck className="h-4 w-4" /> {notice}</p> : null}
      <form ref={form} className={card} onSubmit={(event) => void upload(event)} data-testid="merchant-reels-form">
        <h2 className="flex items-center gap-2 text-base font-black text-[var(--codiq-text)]"><Clapperboard className="h-5 w-5 text-[var(--codiq-accent)]" /> فيديو جديد</h2>
        <p className="text-xs text-[var(--codiq-text-secondary)]">MP4 أو WebM أو MOV، حتى ٣٠ ميغابايت. يفضَّل عموديّاً وأقلّ من دقيقة. يراجعه السوق قبل النشر.</p>
        <label className="block text-xs font-bold text-[var(--codiq-text)]">الفيديو<input name="video" type="file" accept="video/mp4,video/webm,video/quicktime" className={input} required data-testid="merchant-reels-video" /></label>
        <label className="block text-xs font-bold text-[var(--codiq-text)]">صورة الغلاف (اختياريّة)<input name="poster" type="file" accept="image/png,image/jpeg,image/webp" className={input} /></label>
        <label className="block text-xs font-bold text-[var(--codiq-text)]">وصف قصير<input name="caption" maxLength={300} className={input} data-testid="merchant-reels-caption" /></label>
        <label className="block text-xs font-bold text-[var(--codiq-text)]">المنتج الظاهر في الفيديو
          <select name="productId" className={input} defaultValue="" data-testid="merchant-reels-product">
            <option value="">بلا منتج</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
        <Button type="submit" disabled={uploading} data-testid="merchant-reels-submit">{uploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} رفع</Button>
      </form>
      <section className={card}>
        <h2 className="text-base font-black text-[var(--codiq-text)]">فيديوهاتك</h2>
        {!reels ? <LoaderCircle className="h-5 w-5 animate-spin" /> : !reels.length ? <p className="text-sm text-[var(--codiq-text-muted)]">لم ترفع فيديو بعد.</p> : (
          <ul className="divide-y divide-[var(--codiq-border)]">
            {reels.map((reel) => (
              <li key={reel.id} className="space-y-2 py-3" data-testid="merchant-reel-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-[var(--codiq-text)]">{reel.caption || "بلا وصف"}{reel.product ? ` — ${reel.product.name}` : ""}</span>
                    <span className="text-xs text-[var(--codiq-text-secondary)]" data-testid="merchant-reel-status">{STATUS[reel.status] ?? reel.status}</span>
                    {reel.status === "approved" ? <span className="text-xs text-[var(--codiq-text-muted)]"> · {reel.viewCount} مشاهدة · {reel.likeCount} إعجاب</span> : null}
                  </span>
                  <span className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => setPreview(preview === reel.id ? null : reel.id)}>معاينة</Button>
                    <Button type="button" variant="outline" onClick={() => void remove(reel)} data-testid="merchant-reel-delete"><Trash2 className="h-4 w-4" /> حذف</Button>
                  </span>
                </div>
                {reel.status === "rejected" && reel.decisionNote ? <p className="rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs text-[var(--codiq-danger)]">سبب الرفض: {reel.decisionNote}</p> : null}
                {preview === reel.id ? <video src={`/api/merchant/stores/${slug}/market-reels/${reel.id}/video`} controls playsInline className="max-h-96 rounded-2xl bg-[var(--codiq-text)]" /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
