/**
 * إتمام الشراء — for ONE store: delivery or pick-up, the address, how to pay,
 * a coupon, a note, and the total the store's own checkout will charge. The
 * idempotency key lives for the page, so a double tap or a retry after a
 * dropped connection is the same order, never two.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { CircleAlert, LoaderCircle, MapPin, Package, Store, Truck } from "lucide-react";
import { accountCall, displayPhone, useShopper } from "../market-shopper";
import { refreshCart, type CartLine } from "../market-cart";
import { iqd } from "../market-products";
import { MarketSignIn } from "./MarketAccountPages";
import {
  InstalmentChooser,
  type InstalmentOffer,
  type InstalmentPlan,
} from "../components/InstalmentChooser";
import { PartnerPayButton, type PartnerLink } from "./MarketPartnerPages";

type Address = {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  governorate: { name: string };
  district: { name: string };
  addressLine: string;
  isDefault: boolean;
};
type Summary = {
  storeSlug: string;
  store: {
    name: string;
    pickupEnabled: boolean;
    location: { latitude: number; longitude: number; addressLine: string | null } | null;
  };
  lines: CartLine[];
  ready: boolean;
  subtotalIqd: number;
  delivery: { available: boolean; amountIqd: number | null; reason: string | null };
  coupon: { code: string; discountIqd: number; freeShipping: boolean } | { error: string } | null;
  discountIqd: number;
  /** Marketplace M8b: the market coupons he holds, and the one chosen. The platform pays them. */
  platformCoupons: {
    walletId: string;
    code: string;
    title: string;
    usable: boolean;
    reason: string | null;
    discountIqd: number;
  }[];
  platformCoupon: { walletId: string; discountIqd: number } | null;
  platformDiscountIqd: number;
  totalIqd: number;
  paymentMethods: { code: string; displayName: string; kind: string }[];
  /** Marketplace M13a: the market's online methods, when a provider is on. */
  online: { card: { id: string; name: string } | null; instalments: InstalmentOffer | null };
};

const newKey = () =>
  (crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`) + "-market-checkout";

export function MarketCheckoutPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { status, shopper } = useShopper();
  const [, navigate] = useLocation();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [fulfilment, setFulfilment] = useState<"delivery" | "pickup">("delivery");
  const [couponDraft, setCouponDraft] = useState("");
  const [coupon, setCoupon] = useState("");
  const [platformCoupon, setPlatformCoupon] = useState("");
  const [payment, setPayment] = useState("cod");
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [key, setKey] = useState(newKey);
  const [plan, setPlan] = useState<InstalmentPlan | null>(null);
  const [planCode, setPlanCode] = useState("");
  const [partner, setPartner] = useState<PartnerLink>(null);

  useEffect(() => {
    if (shopper)
      void accountCall<{ partner: PartnerLink }>("/api/market/me/partner")
        .then((body) => setPartner(body.partner))
        .catch(() => setPartner(null));
  }, [shopper]);
  useEffect(() => {
    if (!shopper) return;
    accountCall<{ addresses: Address[] }>("/api/market/me/addresses")
      .then((body) => {
        setAddresses(body.addresses);
        setAddressId(
          (current) =>
            current ??
            body.addresses.find((row) => row.isDefault)?.id ??
            body.addresses[0]?.id ??
            null
        );
      })
      .catch((error: Error) => setFailure(error.message));
  }, [shopper]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ fulfilment });
    if (addressId) params.set("addressId", addressId);
    if (coupon) params.set("coupon", coupon);
    if (platformCoupon) params.set("platformCoupon", platformCoupon);
    try {
      setSummary(
        await accountCall<Summary>(`/api/market/checkout/${encodeURIComponent(slug)}?${params}`)
      );
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, [slug, addressId, fulfilment, coupon, platformCoupon]);
  useEffect(() => {
    if (shopper && addresses) void load();
  }, [shopper, addresses, load]);

  const fee = useMemo(
    () =>
      summary?.delivery.available
        ? summary.coupon && "freeShipping" in summary.coupon && summary.coupon.freeShipping
          ? 0
          : (summary.delivery.amountIqd ?? 0)
        : 0,
    [summary]
  );
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;

  const place = async () => {
    if (!addressId || !summary) return;
    setPlacing(true);
    setFailure(null);
    try {
      const result = await accountCall<{
        order: { id: string };
        payment?: { paymentId: string; redirectUrl: string };
      }>(`/api/market/checkout/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "idempotency-key": key },
        // Only a coupon the summary accepted travels: a refused one stays on screen as an explanation, never blocks the order.
        body: JSON.stringify({
          addressId,
          fulfilment,
          paymentMethodCode: payment,
          couponCode: summary.coupon && "code" in summary.coupon ? summary.coupon.code : null,
          note: note.trim() || null,
          platformCouponWalletId: summary.platformCoupon?.walletId ?? null,
          ...(payment === "market_instalments" && plan
            ? { instalmentPaymentId: plan.paymentId, instalmentCode: planCode }
            : {}),
        }),
      });
      await refreshCart();
      // A card order goes to the gateway's page; it comes back to the order once paid.
      if (result.payment) {
        window.location.assign(result.payment.redirectUrl);
        return;
      }
      navigate(`/orders/${result.order.id}?placed=1`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      setFailure((error as Error).message);
      // The cart moved under the shopper: show him the corrected numbers and let the next tap be a new attempt.
      if (
        code === "CART_PRICE_CHANGED" ||
        code === "CART_VERSION_CONFLICT" ||
        code === "IDEMPOTENCY_KEY_REUSED"
      ) {
        setKey(newKey());
        await refreshCart();
        await load();
      }
      // The plan is gone (amount changed, expired, locked): choose the term again.
      if (code?.startsWith("INSTALMENT_") && code !== "INSTALMENT_CODE_WRONG") {
        setPlan(null);
        setPlanCode("");
        setKey(newKey());
        await load();
      }
    } finally {
      setPlacing(false);
    }
  };

  const canPlace =
    summary?.ready &&
    summary.delivery.available &&
    addressId &&
    !placing &&
    payment !== "market_partner" &&
    (payment !== "market_instalments" || (plan && planCode.length === 6));
  return (
    <div className="space-y-4" data-testid="market-checkout">
      <Link href="/cart" className="text-xs font-bold text-[var(--codiq-accent)]">
        ← السلة
      </Link>
      <h1 className="text-xl font-black text-[var(--codiq-text)]">
        إتمام الطلب {summary ? `من ${summary.store.name}` : ""}
      </h1>

      {summary?.store.pickupEnabled ? (
        <section className="grid grid-cols-2 gap-2" data-testid="market-checkout-fulfilment">
          {(
            [
              ["delivery", "توصيل إلى عنواني", Truck],
              ["pickup", "استلام من المتجر", Store],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={fulfilment === value}
              onClick={() => setFulfilment(value)}
              className={`flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-sm font-bold ${fulfilment === value ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] bg-[var(--codiq-surface)] text-[var(--codiq-text)]"}`}
              data-testid={`market-checkout-${value}`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </section>
      ) : null}
      {fulfilment === "pickup" && summary?.store.location ? (
        <a
          href={`https://www.openstreetmap.org/?mlat=${summary.store.location.latitude}&mlon=${summary.store.location.longitude}#map=17/${summary.store.location.latitude}/${summary.store.location.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] p-3 text-xs font-semibold text-[var(--codiq-accent)] shadow-sm"
        >
          <MapPin className="h-4 w-4" /> موقع المتجر
          {summary.store.location.addressLine ? `: ${summary.store.location.addressLine}` : ""} —
          الاتجاهات
        </a>
      ) : null}

      <section
        className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm"
        data-testid="market-checkout-addresses"
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-black text-[var(--codiq-text)]">
            {fulfilment === "pickup" ? "بيانات التواصل" : "عنوان التوصيل"}
          </p>
          <Link
            href="/account/addresses/new"
            className="text-xs font-bold text-[var(--codiq-accent)]"
          >
            إضافة عنوان
          </Link>
        </div>
        {addresses?.length === 0 ? (
          <p className="text-xs text-[var(--codiq-text-muted)]">أضف عنواناً لإتمام الطلب.</p>
        ) : null}
        {addresses?.map((address) => (
          <label
            key={address.id}
            className={`flex cursor-pointer items-start gap-2 rounded-2xl border p-3 ${addressId === address.id ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)]" : "border-[var(--codiq-border)]"}`}
          >
            <input
              type="radio"
              name="address"
              checked={addressId === address.id}
              onChange={() => setAddressId(address.id)}
              className="mt-1"
            />
            <span className="text-xs leading-5 text-[var(--codiq-text-secondary)]">
              <span className="font-bold text-[var(--codiq-text)]">{address.label}</span> —{" "}
              {address.recipientName} · <span dir="ltr">{displayPhone(address.phone)}</span>
              <br />
              {address.governorate.name} · {address.district.name} — {address.addressLine}
            </span>
          </label>
        ))}
      </section>

      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <p className="text-sm font-black text-[var(--codiq-text)]">
          منتجات الطلب {summary ? `(${summary.lines.length.toLocaleString("ar-IQ")})` : ""}
        </p>
        <ul className="space-y-2">
          {summary?.lines.map((line) => (
            <li key={line.id} className="flex items-center gap-2 text-xs">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--codiq-surface-sunken)]">
                {line.product.imageUrl ? (
                  <img src={line.product.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Package className="h-4 w-4 text-[var(--codiq-text-muted)]" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--codiq-text)]">
                {line.product.name}
                {line.variant.name ? ` · ${line.variant.name}` : ""}
                {line.addons.length
                  ? ` + ${line.addons.map((addon) => addon.name).join("، ")}`
                  : ""}{" "}
                × {line.quantity.toLocaleString("ar-IQ")}
              </span>
              <span className="font-bold text-[var(--codiq-text)]">{iqd(line.lineTotalIqd)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm"
        data-testid="market-checkout-payment"
      >
        <p className="text-sm font-black text-[var(--codiq-text)]">طريقة الدفع</p>
        {(summary?.paymentMethods.length
          ? summary.paymentMethods
          : [{ code: "cod", displayName: "الدفع عند الاستلام", kind: "cash" }]
        ).map((method) => (
          <label
            key={method.code}
            className="flex items-center gap-2 text-sm text-[var(--codiq-text)]"
          >
            <input
              type="radio"
              name="payment"
              checked={payment === method.code}
              onChange={() => setPayment(method.code)}
            />{" "}
            {method.displayName}
          </label>
        ))}
        {summary?.online.card ? (
          <label className="flex items-center gap-2 text-sm text-[var(--codiq-text)]">
            <input
              type="radio"
              name="payment"
              checked={payment === "market_card"}
              onChange={() => setPayment("market_card")}
              data-testid="market-checkout-pay-card"
            />{" "}
            بطاقة إلكترونيّة{" "}
            <span className="text-[11px] text-[var(--codiq-text-muted)]">
              ({summary.online.card.name})
            </span>
          </label>
        ) : null}
        {summary?.online.instalments ? (
          <label className="flex items-center gap-2 text-sm text-[var(--codiq-text)]">
            <input
              type="radio"
              name="payment"
              checked={payment === "market_instalments"}
              onChange={() => setPayment("market_instalments")}
              data-testid="market-checkout-pay-instalments"
            />{" "}
            أقساط شهريّة
          </label>
        ) : null}
        {partner?.linked ? (
          <label className="flex items-center gap-2 text-sm text-[var(--codiq-text)]">
            <input
              type="radio"
              name="payment"
              checked={payment === "market_partner"}
              onChange={() => setPayment("market_partner")}
              data-testid="market-checkout-pay-partner"
            />{" "}
            عبر {partner.name}
          </label>
        ) : null}
        {payment === "market_partner" && partner?.linked ? (
          <PartnerPayButton
            slug={slug}
            addressId={addressId}
            fulfilment={fulfilment}
            partnerName={partner.name}
          />
        ) : null}
        {payment === "market_instalments" && summary?.online.instalments ? (
          <InstalmentChooser
            slug={slug}
            offer={summary.online.instalments}
            plan={plan}
            onPlan={setPlan}
            code={planCode}
            onCode={setPlanCode}
            request={{
              addressId,
              fulfilment,
              couponCode: summary.coupon && "code" in summary.coupon ? summary.coupon.code : null,
              platformCouponWalletId: summary.platformCoupon?.walletId ?? null,
            }}
          />
        ) : null}
      </section>

      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <p className="text-sm font-black text-[var(--codiq-text)]">كوبون الخصم</p>
        <div className="flex gap-2">
          <input
            value={couponDraft}
            onChange={(event) => setCouponDraft(event.target.value)}
            placeholder="أدخل رمز الكوبون"
            dir="ltr"
            className="w-full rounded-2xl border border-[var(--codiq-border)] px-3 py-2 text-sm"
            data-testid="market-checkout-coupon"
          />
          <button
            type="button"
            onClick={() => setCoupon(couponDraft.trim())}
            className="shrink-0 rounded-full border border-[var(--codiq-accent)] px-4 text-xs font-bold text-[var(--codiq-accent)]"
            data-testid="market-checkout-coupon-apply"
          >
            تطبيق
          </button>
        </div>
        {summary?.coupon && "error" in summary.coupon ? (
          <p
            className="text-xs text-[var(--codiq-danger)]"
            data-testid="market-checkout-coupon-error"
          >
            {summary.coupon.error}
          </p>
        ) : null}
        {summary?.coupon && "code" in summary.coupon ? (
          <p
            className="text-xs font-semibold text-[var(--codiq-success)]"
            data-testid="market-checkout-coupon-ok"
          >
            طُبّق {summary.coupon.code}
            {summary.coupon.freeShipping
              ? " — توصيل مجانيّ"
              : ` — وفّرت ${iqd(summary.coupon.discountIqd)}`}{" "}
            <button
              type="button"
              onClick={() => {
                setCoupon("");
                setCouponDraft("");
              }}
              className="mr-2 text-[var(--codiq-danger)]"
            >
              إزالة
            </button>
          </p>
        ) : null}
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={2}
          placeholder="ملاحظات للمتجر (اختياريّ)"
          className="w-full rounded-2xl border border-[var(--codiq-border)] px-3 py-2 text-sm"
        />
      </section>
      {summary?.platformCoupons.length ? (
        <section
          className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm"
          data-testid="market-checkout-platform-coupons"
        >
          <p className="text-sm font-black text-[var(--codiq-text)]">كوبونات السوق</p>
          {summary.platformCoupons.map((entry) => (
            <label
              key={entry.walletId}
              className={`flex items-center justify-between gap-2 rounded-2xl border px-3 py-2.5 text-xs ${platformCoupon === entry.walletId ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)]" : "border-[var(--codiq-border)]"} ${entry.usable ? "" : "opacity-60"}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="platform-coupon"
                  disabled={!entry.usable}
                  checked={platformCoupon === entry.walletId}
                  onChange={() => setPlatformCoupon(entry.walletId)}
                  data-testid={`market-checkout-platform-${entry.code}`}
                />
                <span>
                  <span className="block font-bold text-[var(--codiq-text)]">{entry.title}</span>
                  {entry.reason ? (
                    <span className="text-[11px] text-[var(--codiq-text-muted)]">
                      {entry.reason}
                    </span>
                  ) : null}
                </span>
              </span>
              {entry.usable ? (
                <span className="font-black text-[var(--codiq-success)]">
                  − {iqd(entry.discountIqd)}
                </span>
              ) : null}
            </label>
          ))}
          {platformCoupon ? (
            <button
              type="button"
              onClick={() => setPlatformCoupon("")}
              className="text-xs font-bold text-[var(--codiq-danger)]"
            >
              بدون كوبون السوق
            </button>
          ) : null}
        </section>
      ) : null}

      {summary ? (
        <section
          className="space-y-1.5 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-sm shadow-sm"
          data-testid="market-checkout-totals"
        >
          <Row label="المجموع الفرعيّ" value={iqd(summary.subtotalIqd)} />
          {summary.discountIqd ? (
            <Row label="خصم الكوبون" value={`− ${iqd(summary.discountIqd)}`} />
          ) : null}
          {summary.platformDiscountIqd ? (
            <Row label="كوبون السوق" value={`− ${iqd(summary.platformDiscountIqd)}`} />
          ) : null}
          <Row
            label={fulfilment === "pickup" ? "الاستلام من المتجر" : "رسوم التوصيل"}
            value={summary.delivery.available ? (fee === 0 ? "مجاناً" : iqd(fee)) : "—"}
          />
          {!summary.delivery.available && summary.delivery.reason ? (
            <p
              className="text-xs text-[var(--codiq-danger)]"
              data-testid="market-checkout-delivery-problem"
            >
              {summary.delivery.reason}
            </p>
          ) : null}
          <div className="flex justify-between border-t border-[var(--codiq-border)] pt-2 text-base font-black text-[var(--codiq-text)]">
            <span>الإجماليّ</span>
            <span data-testid="market-checkout-total">{iqd(summary.totalIqd)}</span>
          </div>
          {payment === "cod" ? (
            <p className="text-[11px] text-[var(--codiq-text-muted)]">تدفع نقداً عند الاستلام.</p>
          ) : null}
          {payment === "market_card" ? (
            <p className="text-[11px] text-[var(--codiq-text-muted)]">
              تدفع المبلغ كاملاً على صفحة بوابة الدفع بعد التأكيد.
            </p>
          ) : null}
          {payment === "market_instalments" ? (
            <p className="text-[11px] text-[var(--codiq-text-muted)]">
              ثمن المنتجات بالأقساط، ورسوم التوصيل {iqd(fee)} نقداً عند الاستلام.
            </p>
          ) : null}
        </section>
      ) : (
        <p className="text-center text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      )}

      {failure ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]"
          data-testid="market-checkout-error"
        >
          <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void place()}
        disabled={!canPlace}
        className="w-full rounded-full bg-[var(--codiq-accent)] py-3.5 text-sm font-black text-[var(--codiq-surface)] disabled:opacity-50"
        data-testid="market-checkout-place"
      >
        {placing ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} تأكيد الطلب{" "}
        {summary ? `· ${iqd(summary.totalIqd)}` : ""}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-[var(--codiq-text-secondary)]">
      <span>{label}</span>
      <span className="font-bold text-[var(--codiq-text)]">{value}</span>
    </div>
  );
}
