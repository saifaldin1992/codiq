/**
 * Marketplace M8a — a campaign's page: the running «عرض الساعة» with its
 * countdown and products, the next hours, the day-by-day schedule, and the
 * stores taking part. Also the front page's campaign card.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { CalendarDays, Clock, LoaderCircle, Megaphone, Sparkles, Zap } from "lucide-react";
import { marketGet } from "../market-api";
import type { MarketProductCard } from "../market-products";
import type { MarketStoreCard } from "../market-types";
import { ProductCard } from "../components/ProductCard";
import { StoreShelfCard } from "../components/StoreCards";
import { Countdown } from "../components/Countdown";
import { MarketEmptyState } from "../MarketEmptyState";

type Slot = { id: string; title: string | null; startsAt: string; endsAt: string; products?: MarketProductCard[] };
type CampaignPage = {
  campaign: { slug: string; title: string; subtitle: string | null; startsAt: string; endsAt: string; status: "upcoming" | "live" | "ended" };
  days: { day: string; title: string; note: string | null; isToday: boolean; isPast: boolean }[];
  current: (Slot & { products: MarketProductCard[] }) | null;
  upcoming: Slot[];
  stores: MarketStoreCard[];
};

const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString("ar-IQ", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Baghdad" });
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("ar-IQ", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Baghdad" });

export function MarketCampaignPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [page, setPage] = useState<CampaignPage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    marketGet<CampaignPage>(`/api/market/campaigns/${encodeURIComponent(slug)}`, { signal: controller.signal }).then(setPage).catch((error: Error) => { if (error.name !== "AbortError") setFailure(error.message); });
    return () => controller.abort();
  }, [slug]);
  if (failure) return <MarketEmptyState icon={Megaphone} title="الحملة غير متاحة" body={failure} action={<Link href="/" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">الرئيسيّة</Link>} />;
  if (!page) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  const { campaign } = page;
  return (
    <div className="space-y-5" data-testid="market-campaign">
      <section className="space-y-2 rounded-[26px] bg-[var(--codiq-accent)] p-5 text-[var(--codiq-surface)] shadow-sm">
        <p className="inline-flex items-center gap-1 text-xs font-bold opacity-90"><Megaphone className="h-4 w-4" /> {campaign.status === "live" ? "الحملة جارية" : campaign.status === "upcoming" ? "تبدأ قريباً" : "انتهت الحملة"}</p>
        <h1 className="text-2xl font-black" data-testid="market-campaign-title">{campaign.title}</h1>
        {campaign.subtitle ? <p className="text-sm opacity-90">{campaign.subtitle}</p> : null}
        {campaign.status === "live" ? <p className="text-xs opacity-90">تنتهي خلال <Countdown until={campaign.endsAt} /></p> : campaign.status === "upcoming" ? <p className="text-xs opacity-90">تبدأ خلال <Countdown until={campaign.startsAt} /></p> : null}
      </section>

      <section className="space-y-3" data-testid="market-campaign-now">
        <div className="flex items-end justify-between gap-2">
          <h2 className="inline-flex items-center gap-1 text-base font-black text-[var(--codiq-text)]"><Zap className="h-5 w-5 text-[var(--codiq-danger)]" /> عرض الساعة</h2>
          {page.current ? <span className="rounded-full bg-[var(--codiq-danger-soft)] px-3 py-1 text-xs font-black text-[var(--codiq-danger)]" data-testid="market-campaign-countdown">ينتهي خلال <Countdown until={page.current.endsAt} /></span> : null}
        </div>
        {page.current ? (
          page.current.products.length ? <div className="grid grid-cols-2 gap-3">{page.current.products.map((product) => <ProductCard key={product.id} product={product} />)}</div>
            : <p className="rounded-[20px] bg-[var(--codiq-surface)] p-4 text-center text-xs text-[var(--codiq-text-muted)]">لا منتجات في هذه الساعة.</p>
        ) : <p className="rounded-[20px] bg-[var(--codiq-surface)] p-4 text-center text-xs text-[var(--codiq-text-muted)]" data-testid="market-campaign-no-hour">{page.upcoming[0] ? <>العرض القادم يبدأ خلال <Countdown until={page.upcoming[0].startsAt} /></> : "لا عروض ساعة الآن."}</p>}
      </section>

      {page.upcoming.length ? (
        <section className="space-y-3" data-testid="market-campaign-upcoming">
          <h2 className="inline-flex items-center gap-1 text-base font-black text-[var(--codiq-text)]"><Clock className="h-5 w-5 text-[var(--codiq-accent)]" /> العروض القادمة</h2>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
            {page.upcoming.map((slot) => <span key={slot.id} className="shrink-0 rounded-2xl bg-[var(--codiq-surface)] px-4 py-3 text-xs font-bold text-[var(--codiq-text)] shadow-sm">{slot.title ?? "عرض"} — {hourLabel(slot.startsAt)}</span>)}
          </div>
          {page.upcoming[0]?.products?.length ? (
            <>
              <p className="text-xs text-[var(--codiq-text-secondary)]">في العرض القادم (السعر الحاليّ حتّى يبدأ):</p>
              <div className="grid grid-cols-2 gap-3">{page.upcoming[0].products.map((product) => <ProductCard key={product.id} product={product} />)}</div>
            </>
          ) : null}
        </section>
      ) : null}

      {page.days.length ? (
        <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-campaign-days">
          <h2 className="inline-flex items-center gap-1 text-base font-black text-[var(--codiq-text)]"><CalendarDays className="h-5 w-5 text-[var(--codiq-accent)]" /> جدول الأيام</h2>
          <ol className="space-y-1.5">
            {page.days.map((day) => (
              <li key={day.day} className={`flex items-start justify-between gap-2 rounded-2xl px-3 py-2 text-xs ${day.isToday ? "bg-[var(--codiq-accent-soft)] font-bold text-[var(--codiq-accent)]" : day.isPast ? "text-[var(--codiq-text-muted)]" : "text-[var(--codiq-text)]"}`} data-testid={day.isToday ? "market-campaign-today" : undefined}>
                <span>{dayLabel(day.day)}{day.isToday ? " — اليوم" : ""}</span>
                <span className="text-left">{day.title}{day.note ? <span className="block text-[11px] font-normal text-[var(--codiq-text-secondary)]">{day.note}</span> : null}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {page.stores.length ? (
        <section className="space-y-2">
          <h2 className="text-base font-black text-[var(--codiq-text)]">المتاجر المشاركة</h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">{page.stores.map((store) => <StoreShelfCard key={store.slug} store={store} />)}</div>
        </section>
      ) : null}
    </div>
  );
}

type LiveCampaign = { slug: string; title: string; subtitle: string | null; startsAt: string; endsAt: string; nextHour: { startsAt: string; endsAt: string; title: string | null; running: boolean } | null };

/** The front page's card for a running (or about to start) campaign. */
export function CampaignCards() {
  const [campaigns, setCampaigns] = useState<LiveCampaign[]>([]);
  useEffect(() => { void marketGet<{ campaigns: LiveCampaign[] }>("/api/market/campaigns/live").then((body) => setCampaigns(body.campaigns)).catch(() => undefined); }, []);
  if (!campaigns.length) return <WheelCard />;
  return (
    <div className="space-y-3">
      <WheelCard />
      {campaigns.map((campaign) => (
        <Link key={campaign.slug} href={`/campaign/${encodeURIComponent(campaign.slug)}`} className="block space-y-1 rounded-[24px] bg-[var(--codiq-accent)] p-4 text-[var(--codiq-surface)] shadow-sm" data-testid={`market-home-campaign-${campaign.slug}`}>
          <p className="inline-flex items-center gap-1 text-[11px] font-bold opacity-90"><Megaphone className="h-3.5 w-3.5" /> حملة</p>
          <p className="text-lg font-black">{campaign.title}</p>
          {campaign.nextHour ? <p className="inline-flex items-center gap-1 text-xs font-bold"><Zap className="h-3.5 w-3.5" /> {campaign.nextHour.running ? <>عرض الساعة ينتهي خلال <Countdown until={campaign.nextHour.endsAt} /></> : <>عرض الساعة يبدأ خلال <Countdown until={campaign.nextHour.startsAt} /></>}</p> : campaign.subtitle ? <p className="text-xs opacity-90">{campaign.subtitle}</p> : null}
        </Link>
      ))}
    </div>
  );
}

/** The front page's door to the prize wheel, while it is open. */
function WheelCard() {
  const [open, setOpen] = useState<{ title: string } | null>(null);
  useEffect(() => { void marketGet<{ open: boolean; wheel: { title: string } | null }>("/api/market/wheel").then((body) => setOpen(body.open && body.wheel ? body.wheel : null)).catch(() => undefined); }, []);
  if (!open) return null;
  return (
    <Link href="/wheel" className="flex items-center justify-between rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-home-wheel">
      <span><span className="block text-sm font-black text-[var(--codiq-text)]">{open.title}</span><span className="text-xs text-[var(--codiq-text-secondary)]">لفّة مجانيّة كلّ يوم — جرّب حظّك</span></span>
      <Sparkles className="h-7 w-7 text-[var(--codiq-accent)]" />
    </Link>
  );
}
