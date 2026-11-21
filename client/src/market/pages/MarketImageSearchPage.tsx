/**
 * Marketplace M12 — «البحث بالصورة». The shopper takes or picks a photo (the
 * camera button beside every search box); the server measures it and answers
 * the products that look like it, each with how close. The photo is not kept.
 */
import { useEffect, useRef, useState } from "react";
import { useSearch } from "wouter";
import { Camera, ImageOff, LoaderCircle, RefreshCcw } from "lucide-react";
import { MarketApiError } from "../market-api";
import type { MarketProductCard } from "../market-products";
import { ProductCard } from "../components/ProductCard";
import { MarketEmptyState } from "../MarketEmptyState";
import { takePendingPhoto } from "../market-photo";

type Result = MarketProductCard & { similarity: number };

async function searchPhoto(file: File): Promise<Result[]> {
  const form = new FormData();
  form.append("image", file, file.name || "photo.jpg");
  const response = await fetch("/api/market/search/image", { method: "POST", body: form, credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new MarketApiError(body?.error?.message ?? "تعذّر البحث بالصورة.", response.status, body?.error?.code);
  return body.products as Result[];
}

export function PhotoPickerButton({ onPick, className, testId = "market-photo-search" }: { onPick: (file: File) => void; className?: string; testId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => input.current?.click()} aria-label="البحث بالصورة" className={className ?? "shrink-0 text-[var(--codiq-accent)]"} data-testid={testId}><Camera className="h-5 w-5" /></button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" data-testid={`${testId}-file`}
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onPick(file); }} />
    </>
  );
}

export function MarketImageSearchPage() {
  const [photo, setPhoto] = useState<File | null>(() => takePendingPhoto());
  const [preview, setPreview] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A new photo from the search box while already here arrives with a new ?t=.
  const search = useSearch();
  useEffect(() => { const next = takePendingPhoto(); if (next) setPhoto(next); }, [search]);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPreview(url); setResults(null); setFailure(null);
    let alive = true;
    void searchPhoto(photo).then((rows) => { if (alive) setResults(rows); }).catch((error: Error) => { if (alive) setFailure(error.message); });
    return () => { alive = false; URL.revokeObjectURL(url); };
  }, [photo]);

  return (
    <div className="space-y-4" data-testid="market-image-search">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">البحث بالصورة</h1>
        {photo ? <PhotoPickerButton onPick={setPhoto} testId="market-image-search-again" className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-accent)] shadow-sm" /> : null}
      </div>
      {!photo ? (
        <div className="space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-6 text-center shadow-sm">
          <Camera className="mx-auto h-10 w-10 text-[var(--codiq-accent)]" />
          <p className="text-sm font-bold text-[var(--codiq-text)]">صوّر شيئاً أو اختر صورة، ونريك منتجات تشبهه.</p>
          <p className="text-xs text-[var(--codiq-text-muted)]">نقارن الألوان والنقشة والشكل. لا نحتفظ بصورتك.</p>
          <PhotoPickerButton onPick={setPhoto} testId="market-image-search-pick" className="inline-flex items-center gap-2 rounded-full bg-[var(--codiq-accent)] px-4 py-2 text-sm font-bold text-[var(--codiq-surface)]" />
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-[22px] bg-[var(--codiq-surface)] p-3 shadow-sm">
          {preview ? <img src={preview} alt="صورتك" className="h-20 w-20 rounded-2xl object-cover" data-testid="market-image-search-preview" /> : null}
          <p className="text-xs text-[var(--codiq-text-secondary)]">{results ? `${results.length.toLocaleString("ar-IQ")} منتج يشبه صورتك` : failure ? "" : <><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> نقارن صورتك بمنتجات السوق…</>}</p>
        </div>
      )}
      {failure ? <MarketEmptyState icon={ImageOff} title="تعذّر البحث بهذه الصورة" body={failure} testId="market-image-search-failed" /> : null}
      {results && !results.length ? <MarketEmptyState icon={RefreshCcw} title="لم نجد منتجاً يشبهها" body="جرّب صورة أوضح للمنتج وحده، بإضاءة جيّدة ومن الأمام." testId="market-image-search-empty" /> : null}
      {results?.length ? (
        <div className="grid grid-cols-2 gap-3" data-testid="market-image-search-results">
          {results.map((product) => (
            <div key={product.id} className="relative" data-testid="market-image-search-result">
              <ProductCard product={product} />
              <span className="absolute left-2 top-2 rounded-full bg-[var(--codiq-surface)] px-2 py-0.5 text-[10px] font-black text-[var(--codiq-accent)] shadow" data-testid="market-image-search-similarity">تشابه {product.similarity.toLocaleString("ar-IQ")}٪</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
