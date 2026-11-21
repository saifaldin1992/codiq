/**
 * «التوصيل إلى البيت: ٥٬٠٠٠ د.ع» — what this store charges to the signed-in
 * shopper's default address, or that it does not deliver there. Shown only to
 * a signed-in shopper with an address; everyone else sees nothing.
 */
import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";

type Quote = { available: boolean; amountIqd: number | null; governorate: { name: string } };

export function DeliveryToMe({ storeSlug }: { storeSlug: string }) {
  const { shopper } = useShopper();
  const [quote, setQuote] = useState<(Quote & { label: string }) | null>(null);
  useEffect(() => {
    if (!shopper) {
      setQuote(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { addresses } = await accountCall<{
          addresses: { id: string; label: string; isDefault: boolean }[];
        }>("/api/market/me/addresses");
        const address = addresses.find((row) => row.isDefault);
        if (!address) return;
        const result = await accountCall<Quote>(
          `/api/market/me/addresses/${address.id}/delivery?store=${encodeURIComponent(storeSlug)}`
        );
        if (alive) setQuote({ ...result, label: address.label });
      } catch {
        /* nothing to show */
      }
    })();
    return () => {
      alive = false;
    };
  }, [shopper, storeSlug]);
  if (!quote) return null;
  return (
    <p
      className={`flex items-center gap-2 rounded-2xl px-3 py-2.5 text-xs font-semibold ${quote.available ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]"}`}
      data-testid="market-delivery-to-me"
    >
      <Truck className="h-4 w-4 shrink-0" />
      {quote.available
        ? `التوصيل إلى ${quote.label} (${quote.governorate.name}): ${quote.amountIqd === 0 ? "مجاناً" : `${(quote.amountIqd ?? 0).toLocaleString("ar-IQ")} د.ع`}`
        : `هذا المتجر لا يوصّل إلى ${quote.governorate.name} حالياً`}
    </p>
  );
}
