/**
 * «عروض الساعة» — the store puts its products forward for an hour of a market
 * campaign at a percentage off. The store funds it: for that hour the product
 * simply sells lower. Live once the market approves; fixed once the hour starts.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

type Deal = {
  id: string;
  percentOff: number;
  status: string;
  decisionNote: string | null;
  product: { id: string; name: string; priceIqd: number };
};
type Slot = {
  id: string;
  title: string | null;
  startsAt: string;
  endsAt: string;
  open: boolean;
  deals: Deal[];
};
type Campaign = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  startsAt: string;
  endsAt: string;
  minPercent: number;
  slots: Slot[];
};
type Product = { id: string; name: string; priceIqd: number };

const STATUS: Record<string, string> = {
  pending: "بانتظار موافقة السوق",
  approved: "معتمد",
  rejected: "مرفوض",
  withdrawn: "مسحوب",
};
const money = (value: number) => `${value.toLocaleString("ar-IQ")} د.ع`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("ar-IQ", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Baghdad",
  });

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

export function MarketDealsPanel({ storeSlug }: { storeSlug?: string }) {
  const slug = encodeURIComponent(storeSlug ?? "");
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [draft, setDraft] = useState<Record<string, { productId: string; percentOff: number }>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCampaigns(
        (await call<{ campaigns: Campaign[] }>(`/api/merchant/stores/${slug}/market-campaigns`))
          .campaigns
      );
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, [slug]);
  useEffect(() => {
    void load();
    void call<{ products: Product[] }>(
      `/api/merchant/stores/${slug}/market-catalog/products?limit=100`
    )
      .then((body) => setProducts(body.products))
      .catch(() => undefined);
  }, [load, slug]);
  async function propose(slot: Slot, campaign: Campaign) {
    const entry = draft[slot.id];
    if (!entry?.productId) return;
    try {
      await call(`/api/merchant/stores/${slug}/market-deals`, {
        method: "POST",
        body: JSON.stringify({
          slotId: slot.id,
          productId: entry.productId,
          percentOff: Math.max(entry.percentOff || campaign.minPercent, 1),
        }),
      });
      setNotice("أُرسل العرض لموافقة السوق.");
      setFailure(null);
      await load();
    } catch (error) {
      setFailure((error as Error).message);
      setNotice(null);
    }
  }
  async function withdraw(deal: Deal) {
    try {
      await call(`/api/merchant/stores/${slug}/market-deals/${deal.id}`, { method: "DELETE" });
      setNotice("سُحب العرض.");
      setFailure(null);
      await load();
    } catch (error) {
      setFailure((error as Error).message);
      setNotice(null);
    }
  }
  if (!campaigns)
    return (
      <p className="text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  return (
    <div className="max-w-[960px] space-y-4" data-testid="market-deals-panel">
      <p className="rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3 text-sm text-[var(--codiq-accent)]">
        خلال ساعة العرض يُباع المنتج بسعره بعد الخصم في السوق وفي متجرك. الخصم على حساب متجرك، ولا
        يتغيّر شيء بعد بدء الساعة.
      </p>
      {failure ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          data-testid="market-deals-error"
        >
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          data-testid="market-deals-notice"
        >
          <CircleCheck className="h-4 w-4" /> {notice}
        </p>
      ) : null}
      {campaigns.length === 0 ? (
        <p className="rounded-[24px] bg-[var(--codiq-surface)] p-6 text-sm text-[var(--codiq-text-muted)]">
          لا حملات مفتوحة الآن.
        </p>
      ) : null}
      {campaigns.map((campaign) => (
        <section
          key={campaign.id}
          className="space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm"
          data-testid={`market-deals-campaign-${campaign.slug}`}
        >
          <div>
            <h3 className="font-bold text-[var(--codiq-text)]">{campaign.title}</h3>
            <p className="text-xs text-[var(--codiq-text-muted)]">
              {when(campaign.startsAt)} — {when(campaign.endsAt)} · أقلّ خصم {campaign.minPercent}%
            </p>
          </div>
          {campaign.slots.length === 0 ? (
            <p className="text-sm text-[var(--codiq-text-muted)]">لا ساعات عروض بعد.</p>
          ) : null}
          <ul className="divide-y divide-[var(--codiq-border)]">
            {campaign.slots.map((slot) => (
              <li key={slot.id} className="space-y-2 py-3">
                <p className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--codiq-text)]">
                  <Zap className="h-4 w-4 text-[var(--codiq-danger)]" />{" "}
                  {slot.title ?? "عرض الساعة"} — {when(slot.startsAt)}
                  {slot.open ? "" : " (بدأت)"}
                </p>
                {slot.deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2 text-sm"
                    data-testid={`market-deal-${deal.id}`}
                  >
                    <span>
                      {deal.product.name} — خصم {deal.percentOff}% ({money(deal.product.priceIqd)} ←{" "}
                      {money(
                        deal.product.priceIqd -
                          Math.ceil((deal.product.priceIqd * deal.percentOff) / 100)
                      )}
                      )
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[var(--codiq-accent)]">
                        {STATUS[deal.status] ?? deal.status}
                        {deal.decisionNote ? ` — ${deal.decisionNote}` : ""}
                      </span>
                      {slot.open && (deal.status === "pending" || deal.status === "approved") ? (
                        <Button size="sm" variant="outline" onClick={() => void withdraw(deal)}>
                          سحب
                        </Button>
                      ) : null}
                    </span>
                  </div>
                ))}
                {slot.open ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={draft[slot.id]?.productId ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          [slot.id]: {
                            percentOff: draft[slot.id]?.percentOff ?? campaign.minPercent,
                            productId: event.target.value,
                          },
                        })
                      }
                      className="h-10 min-w-[220px] rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm"
                      data-testid={`market-deal-product-${slot.id}`}
                    >
                      <option value="">اختر منتجاً</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} — {money(product.priceIqd)}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-sm">
                      خصم{" "}
                      <input
                        type="number"
                        min={campaign.minPercent}
                        max={90}
                        value={draft[slot.id]?.percentOff ?? campaign.minPercent}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            [slot.id]: {
                              productId: draft[slot.id]?.productId ?? "",
                              percentOff: Number(event.target.value),
                            },
                          })
                        }
                        className="h-10 w-20 rounded-xl border border-[var(--codiq-border)] px-2"
                        data-testid={`market-deal-percent-${slot.id}`}
                      />
                      %
                    </label>
                    <Button
                      disabled={!draft[slot.id]?.productId}
                      onClick={() => void propose(slot, campaign)}
                      data-testid={`market-deal-propose-${slot.id}`}
                    >
                      اقترح
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
