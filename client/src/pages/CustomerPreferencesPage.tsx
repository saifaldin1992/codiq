/**
 * ق-251 (المرحلة 29-3) — «تفضيلاتي»: what applies to this customer in this
 * shop and who decided it. Marketing mail is his own last word (the unsubscribe
 * link in every message); guest checkout and loyalty are the shop's and the
 * platform's, shown here so «why can't I…» has an answer he can read.
 */
import { useEffect, useState } from "react";
import { BellRing, Gift, SlidersHorizontal, UserRoundCheck } from "lucide-react";
import { useStorefront } from "@/components/StorefrontProvider";
import { ErrorState, LoadingState } from "@/components/StorefrontStates";
import { errorMessage, storefrontApi, type CustomerPreferences } from "@/lib/storefront-api";

const SOURCE_TEXT: Record<string, string> = {
  default: "الإعداد الافتراضيّ",
  platform: "قرار المنصّة",
  plan: "خطّة المتجر",
  merchant: "قرار صاحب المتجر",
  store: "إعداد المتجر",
  customer: "اختيارك أنت",
};

export default function CustomerPreferencesPage() {
  const { slug } = useStorefront();
  const [preferences, setPreferences] = useState<CustomerPreferences | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    storefrontApi
      .preferences(slug)
      .then((payload) => {
        if (!cancelled) setPreferences(payload.preferences);
      })
      .catch((error) => {
        if (!cancelled) setFailure(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (failure) return <ErrorState message={failure} />;
  if (!preferences) return <LoadingState />;

  const rows = [
    {
      icon: BellRing,
      title: "الرسائل التسويقيّة",
      entry: preferences.marketingOptIn,
      on: "تصلك عروض المتجر ورسائله",
      off: "لا تصلك رسائل تسويقيّة من هذا المتجر",
      hint: "كلمتك الأخيرة: رابط «إلغاء الاشتراك» في أيّ رسالة يوقفها، ورسائل طلباتك تصلك دائماً.",
    },
    {
      icon: UserRoundCheck,
      title: "الشراء دون حساب",
      entry: preferences.guestCheckout,
      on: "يمكن إتمام الطلب دون تسجيل",
      off: "هذا المتجر يطلب حساباً لإتمام الطلب",
      hint: "يقرّره المتجر أو المنصّة.",
    },
    {
      icon: Gift,
      title: "نقاط الولاء",
      entry: preferences.loyalty,
      on: "تكسب نقاطاً على طلباتك",
      off: "لا نقاط ولاء في هذا المتجر الآن",
      hint: "يقرّره المتجر أو المنصّة.",
    },
  ];

  return (
    <section className="space-y-4" data-testid="customer-preferences">
      <h1 className="flex items-center gap-2 text-xl font-black text-[var(--storefront-text)]">
        <SlidersHorizontal className="h-5 w-5 text-[var(--storefront-accent)]" />
        تفضيلاتي
      </h1>
      <p className="text-sm leading-6 text-[var(--storefront-muted)]">
        ما ينطبق عليك في هذا المتجر، ومن قرّره.
      </p>
      <ul className="space-y-3">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <li
              key={row.title}
              className="rounded-[22px] bg-[var(--storefront-surface)] p-4 shadow-sm"
              data-testid={`preference-${row.title}`}
            >
              <p className="flex items-center gap-2 font-bold text-[var(--storefront-text)]">
                <Icon className="h-4 w-4 text-[var(--storefront-accent)]" />
                {row.title}
              </p>
              <p className="mt-1 text-sm text-[var(--storefront-text)]">
                {row.entry.value ? row.on : row.off}{" "}
                <span className="mr-2 rounded-full bg-[var(--storefront-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-accent-on-soft)]">
                  {SOURCE_TEXT[row.entry.source] ?? row.entry.sourceLabel}
                </span>
              </p>
              <p className="mt-1 text-xs text-[var(--storefront-muted)]">{row.hint}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
