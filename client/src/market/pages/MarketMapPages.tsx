/**
 * Marketplace M11 — «خريطة المتاجر» and «على طريقك».
 *
 * The map asks the server for the stores inside what is on screen each time
 * it settles; a tap on a pin opens the store's card. «موقعي» asks for the
 * position only when pressed. «على طريقك» takes two points — the shopper's
 * position, a saved address, or a tap on the map — and lists the stores near
 * the straight line between them, in the order he passes them.
 *
 * Loaded on demand (Leaflet stays out of the rest of the market's bundle).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { CircleAlert, Crosshair, List, LoaderCircle, Map as MapIcon, MapPinned, Navigation, Star, X } from "lucide-react";
import { marketGet } from "../market-api";
import { accountCall, useShopper } from "../market-shopper";
import { LOCATE_TEXT, locateShopper, type LatLng, type LocateFailure } from "../market-geo";
import { StoreListRow } from "../components/StoreCards";
import type { MarketStoreCard } from "../market-types";
import { StoreMap, type MapBox, type MapConfig, type MapPin } from "../map/StoreMap";

function useMapConfig() {
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { void marketGet<MapConfig>("/api/market/map/config").then(setConfig).catch((error: Error) => setFailure(error.message)); }, []);
  return { config, failure };
}

function useLocate() {
  const [me, setMe] = useState<LatLng | null>(null);
  const [state, setState] = useState<"idle" | "asking" | LocateFailure>("idle");
  const locate = useCallback(async () => {
    setState("asking");
    try { const point = await locateShopper(); setMe(point); setState("idle"); return point; } catch (failure) { setState(failure as LocateFailure); return null; }
  }, []);
  return { me, state, locate };
}

const roundBox = (box: MapBox) => ({ south: box.south.toFixed(4), west: box.west.toFixed(4), north: box.north.toFixed(4), east: box.east.toFixed(4) });
const MIN_PIN_ZOOM = 9;

export function MarketMapPage() {
  const { config, failure } = useMapConfig();
  const { me, state, locate } = useLocate();
  const [pins, setPins] = useState<MapPin[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [tooFar, setTooFar] = useState(false);
  const [selected, setSelected] = useState<MapPin | null>(null);
  const [focus, setFocus] = useState<{ point: LatLng; zoom?: number; at: number } | null>(null);
  const [view, setView] = useState<"map" | "list">("map");
  const generation = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const onMove = useCallback((box: MapBox, zoom: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (zoom < MIN_PIN_ZOOM) { setTooFar(true); return; }
      setTooFar(false);
      const mine = ++generation.current;
      const query = new URLSearchParams(roundBox(box)).toString();
      void marketGet<{ pins: MapPin[]; truncated: boolean }>(`/api/market/stores/map?${query}`)
        .then((body) => { if (mine === generation.current) { setPins(body.pins); setTruncated(body.truncated); } })
        .catch(() => undefined);
    }, 250);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (failure) return <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">{failure}</p>;
  if (!config) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  return (
    <div className="space-y-3" data-testid="market-map-page">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">خريطة المتاجر</h1>
        <div className="flex gap-2">
          <button type="button" onClick={() => setView(view === "map" ? "list" : "map")} className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text)] shadow-sm" data-testid="market-map-view">
            {view === "map" ? <><List className="h-4 w-4" /> قائمة</> : <><MapIcon className="h-4 w-4" /> خريطة</>}
          </button>
          <Link href="/route" className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-accent)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-surface)]" data-testid="market-map-to-route"><Navigation className="h-4 w-4" /> على طريقك</Link>
        </div>
      </div>
      <div className={view === "map" ? "relative" : "hidden"}>
        <StoreMap config={config} pins={pins} selected={selected?.slug} onSelect={setSelected} onMove={onMove} onTap={() => setSelected(null)} me={me} focus={focus} />
        <button type="button" onClick={() => void locate().then((point) => point && setFocus({ point, zoom: 15, at: Date.now() }))} disabled={state === "asking"} className="absolute bottom-3 left-3 z-[500] inline-flex items-center gap-1 rounded-full bg-[var(--codiq-surface)] px-3 py-2 text-xs font-bold text-[var(--codiq-text)] shadow" data-testid="market-map-locate">
          {state === "asking" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4 text-[var(--codiq-accent)]" />} موقعي
        </button>
        {tooFar ? <p className="absolute inset-x-3 top-3 z-[500] rounded-2xl bg-[var(--codiq-surface)] px-3 py-2 text-center text-xs font-bold text-[var(--codiq-text)] shadow" data-testid="market-map-zoom-in">قرّب الخريطة لترى المتاجر</p> : truncated ? <p className="absolute inset-x-3 top-3 z-[500] rounded-2xl bg-[var(--codiq-surface)] px-3 py-2 text-center text-xs text-[var(--codiq-text-secondary)] shadow">نعرض أفضل ٣٠٠ متجر هنا — قرّب لترى البقيّة</p> : null}
        {!config.tiles ? <p className="absolute bottom-3 right-3 z-[500] rounded-full bg-[var(--codiq-surface)] px-3 py-1 text-[10px] text-[var(--codiq-text-muted)] shadow">خلفيّة الخريطة غير مفعّلة</p> : null}
      </div>
      {state === "denied" || state === "unavailable" ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-warning)]"><CircleAlert className="h-4 w-4" /> {LOCATE_TEXT[state]}</p> : null}
      {view === "map" && selected ? (
        <div className="flex items-center gap-3 rounded-[22px] bg-[var(--codiq-surface)] p-3 shadow-sm" data-testid="market-map-card">
          {selected.logoUrl ? <img src={selected.logoUrl} alt="" className="h-12 w-12 rounded-2xl object-cover" /> : <MapPinned className="h-10 w-10 text-[var(--codiq-accent)]" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-black text-[var(--codiq-text)]" data-testid="market-map-card-name">{selected.name}</p>
            <p className="flex items-center gap-2 text-[11px] text-[var(--codiq-text-muted)]">
              {selected.businessType ? <span>{selected.businessType}</span> : null}
              {selected.rating !== null ? <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3 fill-[var(--codiq-warning)] text-[var(--codiq-warning)]" />{selected.rating.toFixed(1)} ({selected.ratingCount})</span> : null}
              {selected.pickupEnabled ? <span>استلام من المتجر</span> : null}
            </p>
          </div>
          <Link href={`/s/${encodeURIComponent(selected.slug)}`} className="rounded-full bg-[var(--codiq-accent)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-surface)]" data-testid="market-map-card-open">زيارة</Link>
          <button type="button" onClick={() => setSelected(null)} aria-label="إغلاق"><X className="h-4 w-4 text-[var(--codiq-text-muted)]" /></button>
        </div>
      ) : null}
      {view === "list" ? (
        <div className="space-y-2" data-testid="market-map-list">
          {pins.length ? pins.map((pin) => (
            <Link key={pin.slug} href={`/s/${encodeURIComponent(pin.slug)}`} className="flex items-center justify-between rounded-[18px] bg-[var(--codiq-surface)] p-3 text-sm font-bold text-[var(--codiq-text)] shadow-sm">
              {pin.name}{pin.rating !== null ? <span className="text-xs text-[var(--codiq-text-muted)]">★ {pin.rating.toFixed(1)}</span> : null}
            </Link>
          )) : <p className="text-sm text-[var(--codiq-text-muted)]">لا متاجر في هذه المنطقة من الخريطة.</p>}
        </div>
      ) : null}
    </div>
  );
}

type Address = { id: string; label: string; location: { latitude: number; longitude: number } | null };
type RouteStore = MarketStoreCard & { alongKm: number };
type RouteResult = { routeKm: number; corridorKm: number; stores: RouteStore[]; truncated: boolean };
const CORRIDORS = [0.5, 1, 2, 5];
const metres = (km: number) => (km < 1 ? `${Math.round(km * 1000).toLocaleString("ar-IQ")} م` : `${km.toLocaleString("ar-IQ")} كم`);

export function MarketRoutePage() {
  const { config, failure } = useMapConfig();
  const { shopper } = useShopper();
  const { me, state, locate } = useLocate();
  const [from, setFrom] = useState<LatLng | null>(null);
  const [to, setTo] = useState<LatLng | null>(null);
  const [picking, setPicking] = useState<"from" | "to" | null>("from");
  const [corridor, setCorridor] = useState(1);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [fit, setFit] = useState(0);

  useEffect(() => {
    if (!shopper) { setAddresses([]); return; }
    void accountCall<{ addresses: Address[] }>("/api/market/me/addresses").then((body) => setAddresses(body.addresses.filter((row) => row.location))).catch(() => undefined);
  }, [shopper]);

  const place = (which: "from" | "to", point: LatLng) => {
    if (which === "from") { setFrom(point); setPicking(to ? null : "to"); } else { setTo(point); setPicking(from ? null : "from"); }
    setResult(null); setProblem(null);
  };

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setSearching(true); setProblem(null);
    const query = `from=${from.lat.toFixed(6)},${from.lng.toFixed(6)}&to=${to.lat.toFixed(6)},${to.lng.toFixed(6)}&corridor=${corridor}`;
    marketGet<RouteResult>(`/api/market/stores/on-route?${query}`)
      .then((body) => { if (alive) { setResult(body); setFit(Date.now()); } })
      .catch((error: Error) => { if (alive) { setResult(null); setProblem(error.message); } })
      .finally(() => { if (alive) setSearching(false); });
    return () => { alive = false; };
  }, [from, to, corridor]);

  if (failure) return <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">{failure}</p>;
  if (!config) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  const pins: MapPin[] = (result?.stores ?? []).filter((row) => row.location).map((row) => ({ slug: row.slug, name: row.name, latitude: row.location!.latitude, longitude: row.location!.longitude, logoUrl: row.logoUrl, rating: row.rating, ratingCount: row.ratingCount, verified: row.marks.includes("verified"), businessType: row.businessType, pickupEnabled: row.pickupEnabled }));
  const chip = (on: boolean) => `rounded-full px-3 py-1.5 text-xs font-bold ${on ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`;
  const pointButtons = (which: "from" | "to") => (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={chip(picking === which)} onClick={() => setPicking(which)} data-testid={`market-route-${which}-tap`}>اختر على الخريطة</button>
      <button type="button" className={chip(false)} onClick={() => void locate().then((point) => point && place(which, point))} data-testid={`market-route-${which}-me`}>
        {state === "asking" ? <LoaderCircle className="ml-1 inline h-3 w-3 animate-spin" /> : null}موقعي
      </button>
      {addresses.map((address) => <button key={address.id} type="button" className={chip(false)} onClick={() => place(which, { lat: address.location!.latitude, lng: address.location!.longitude })} data-testid={`market-route-${which}-address`}>{address.label}</button>)}
    </div>
  );
  return (
    <div className="space-y-3" data-testid="market-route-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">على طريقك</h1>
        <Link href="/map" className="text-xs font-bold text-[var(--codiq-accent)]">خريطة المتاجر</Link>
      </div>
      <p className="text-xs text-[var(--codiq-text-secondary)]">خطّط مشوارك: حدّد من أين ستنطلق وإلى أين، ونعرض المتاجر القريبة من الخطّ بينهما بالترتيب الذي ستمرّ عليها.</p>
      <section className="space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-3 shadow-sm">
        <p className="text-xs font-black text-[var(--codiq-text)]">أ — من {from ? <span className="font-semibold text-[var(--codiq-success)]" data-testid="market-route-from-set">✓ محدّد</span> : null}</p>
        {pointButtons("from")}
        <p className="pt-1 text-xs font-black text-[var(--codiq-text)]">ب — إلى {to ? <span className="font-semibold text-[var(--codiq-success)]" data-testid="market-route-to-set">✓ محدّد</span> : null}</p>
        {pointButtons("to")}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs font-bold text-[var(--codiq-text-secondary)]">بُعد المتجر عن طريقك حتى</span>
          {CORRIDORS.map((value) => <button key={value} type="button" className={chip(corridor === value)} aria-pressed={corridor === value} onClick={() => setCorridor(value)} data-testid={`market-route-corridor-${value}`}>{metres(value)}</button>)}
        </div>
      </section>
      {picking ? <p className="rounded-2xl bg-[var(--codiq-accent-soft)] px-3 py-2 text-xs font-bold text-[var(--codiq-accent)]" data-testid="market-route-hint">اضغط على الخريطة لتحديد {picking === "from" ? "نقطة الانطلاق (أ)" : "الوجهة (ب)"}</p> : null}
      {state === "denied" || state === "unavailable" ? <p className="rounded-2xl bg-[var(--codiq-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-warning)]">{LOCATE_TEXT[state]}</p> : null}
      <StoreMap config={config} pins={pins} onTap={(point) => { if (picking) place(picking, point); }} me={me} route={{ from, to, corridorKm: corridor }} fitRoute={fit} className="h-[45vh] min-h-[280px] w-full overflow-hidden rounded-[24px] bg-[var(--codiq-surface-sunken)]" />
      {problem ? <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-route-problem">{problem}</p> : null}
      {searching ? <p className="text-center text-xs text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> نبحث على طريقك…</p> : null}
      {result ? (
        <section className="space-y-2" data-testid="market-route-results">
          <p className="text-sm font-black text-[var(--codiq-text)]" data-testid="market-route-summary">
            {result.stores.length ? `${result.stores.length.toLocaleString("ar-IQ")} متجر على طريقك` : "لا متاجر قريبة من هذا الطريق"} · المشوار {result.routeKm.toLocaleString("ar-IQ")} كم بخطّ مستقيم
          </p>
          {result.stores.map((store) => (
            <div key={store.slug} className="space-y-1" data-testid="market-route-store">
              <p className="px-1 text-[11px] font-bold text-[var(--codiq-accent)]">بعد {metres(store.alongKm)} من البداية · {metres(store.distanceKm ?? 0)} عن طريقك</p>
              <StoreListRow store={{ ...store, distanceKm: null }} />
            </div>
          ))}
          {!result.stores.length ? <button type="button" className={chip(false)} onClick={() => setCorridor(5)}>وسّع البحث إلى ٥ كم</button> : null}
          {result.truncated ? <p className="text-xs text-[var(--codiq-text-muted)]">نعرض أوّل ٥٠ متجراً على الطريق.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
