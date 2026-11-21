/**
 * «التوصيل إلى» — a bottom sheet: governorate first, then (optionally) the
 * district inside it. Both lists are searchable, because eighteen and
 * twenty-six rows are too many to scan on a phone.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, LoaderCircle, MapPin, Search, X } from "lucide-react";
import { loadMarketGeography, type MarketGeography } from "./market-api";
import type { MarketLocation } from "./market-location";
import { normalizeArabicV1 as normalizeForSearch } from "@shared/search/arabic-normalize";

type Props = { current: MarketLocation | null; onPick: (location: MarketLocation | null) => void; onClose: () => void };

export function LocationPicker({ current, onPick, onClose }: Props) {
  const [geography, setGeography] = useState<MarketGeography | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [governorateKey, setGovernorateKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    loadMarketGeography().then((value) => alive && setGeography(value)).catch((error: Error) => alive && setFailure(error.message));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const governorate = geography?.governorates.find((row) => row.key === governorateKey) ?? null;
  const needle = normalizeForSearch(query);
  const governorates = useMemo(
    () => (geography?.governorates ?? []).filter((row) => !needle || normalizeForSearch(row.name).includes(needle)),
    [geography, needle],
  );
  const districts = useMemo(
    () => (governorate?.districts ?? []).filter((row) => !needle || normalizeForSearch(row.name).includes(needle)),
    [governorate, needle],
  );

  const pickGovernorate = (key: string) => { setGovernorateKey(key); setQuery(""); };
  const finish = (district: { id: number; name: string } | null) => {
    if (!governorate) return;
    onPick({ governorateKey: governorate.key, governorateName: governorate.name, districtId: district?.id ?? null, districtName: district?.name ?? null });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--codiq-text)]/40" role="dialog" aria-modal="true" aria-label="التوصيل إلى" data-testid="market-location-picker" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-[560px] flex-col rounded-t-[28px] bg-[var(--codiq-surface)] p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          {governorate ? (
            <button type="button" className="flex items-center gap-1 text-sm font-bold text-[var(--codiq-accent)]" onClick={() => { setGovernorateKey(null); setQuery(""); }}>
              <ChevronLeft className="h-4 w-4 rotate-180" /> المحافظات
            </button>
          ) : <p className="text-base font-bold text-[var(--codiq-text)]">اختر محافظتك</p>}
          <button type="button" aria-label="إغلاق" className="rounded-full p-2 text-[var(--codiq-text-muted)] hover:bg-[var(--codiq-surface-sunken)]" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        {governorate ? <p className="mb-2 text-base font-bold text-[var(--codiq-text)]">{governorate.name} — اختر المنطقة</p> : null}
        <label className="mb-3 flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5">
          <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={governorate ? "ابحث عن منطقة" : "ابحث عن محافظة"} className="w-full bg-transparent text-sm text-[var(--codiq-text)] outline-none" data-testid="market-location-search" />
        </label>
        <div className="min-h-[200px] overflow-y-auto">
          {failure ? <p className="py-8 text-center text-sm text-[var(--codiq-danger)]">{failure}</p>
            : !geography ? <p className="py-8 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>
            : governorate ? (
              <ul className="divide-y divide-[var(--codiq-border)]">
                <li><button type="button" className="w-full py-3 text-right text-sm font-bold text-[var(--codiq-accent)]" onClick={() => finish(null)}>كل مناطق {governorate.name}</button></li>
                {districts.map((district) => (
                  <li key={district.id}><button type="button" className="w-full py-3 text-right text-sm text-[var(--codiq-text)]" onClick={() => finish(district)} data-testid={`market-district-${district.id}`}>{district.name}</button></li>
                ))}
                {districts.length === 0 ? <li className="py-6 text-center text-sm text-[var(--codiq-text-muted)]">لا توجد منطقة بهذا الاسم</li> : null}
              </ul>
            ) : (
              <ul className="divide-y divide-[var(--codiq-border)]">
                {current ? <li><button type="button" className="w-full py-3 text-right text-sm font-bold text-[var(--codiq-text-muted)]" onClick={() => { onPick(null); onClose(); }}>كل المحافظات</button></li> : null}
                {governorates.map((row) => (
                  <li key={row.key}>
                    <button type="button" className="flex w-full items-center justify-between py-3 text-right text-sm text-[var(--codiq-text)]" onClick={() => pickGovernorate(row.key)} data-testid={`market-governorate-${row.key}`}>
                      <span className="flex items-center gap-2"><MapPin className="h-4 w-4 text-[var(--codiq-text-muted)]" /> {row.name}</span>
                      <ChevronLeft className="h-4 w-4 text-[var(--codiq-text-muted)]" />
                    </button>
                  </li>
                ))}
                {governorates.length === 0 ? <li className="py-6 text-center text-sm text-[var(--codiq-text-muted)]">لا توجد محافظة بهذا الاسم</li> : null}
              </ul>
            )}
        </div>
      </div>
    </div>
  );
}
