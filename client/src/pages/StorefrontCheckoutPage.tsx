/**
 * ق-203 — checkout in the reference's arrangement, on the platform's rules.
 *
 * Three ways in, one page: a signed-in shopper with his saved addresses; a
 * GUEST (ق-201) who types his name, phone and address when the merchant
 * allows buying without an account; and, when the merchant does not, the
 * sign-in door with the way back kept. Then the payment methods the merchant
 * switched on (ق-209) — with what a wallet transfer needs the shopper to
 * know — the delivery note, the coupon, the points (accounts only), and the
 * summary whose total is the one the server will compute.
 */
import { LoyaltyRedeem } from "@/components/LoyaltyRedeem";
import { AddressForm, emptyAddress, type AddressDraft } from "@/components/AddressForm";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Banknote,
  CheckCircle2,
  MapPin,
  PackageCheck,
  Plus,
  RefreshCw,
  ShieldCheck,
  TicketPercent,
  Truck,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStorefront } from "@/components/StorefrontProvider";
import { EmptyState, ErrorState, LoadingState } from "@/components/StorefrontStates";
import {
  Address,
  CouponPreview,
  DeliveryArea,
  DeliveryQuote,
  errorMessage,
  formatIqd,
  PublicPaymentMethod,
  RefusedCartLine,
  refusedLines,
  StorefrontApiError,
  storefrontApi,
} from "@/lib/storefront-api";
import { trackPurchase } from "@/lib/storefront-pixels";

function newAttemptKey() {
  return crypto.randomUUID();
}

const CASH: PublicPaymentMethod = { code: "cod", displayName: "الدفع عند الاستلام", kind: "cod" };
const POLICY_LABELS = {
  return: "سياسة الإرجاع والاستبدال",
  privacy: "سياسة الخصوصية",
  delivery: "سياسة التوصيل",
} as const;

export default function StorefrontCheckoutPage() {
  const {
    slug,
    cart,
    customer,
    config,
    loading: storefrontLoading,
    refreshCart,
    setNotice,
    setCustomer,
  } = useStorefront();
  const [, navigate] = useLocation();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AddressDraft>(emptyAddress);
  // ق-162: the governorates this store delivers to. Loaded once, publicly, and
  // BEFORE the shopper types anything — a field that asks him to guess a value
  // the server matches exactly is a field that refuses him at the last step.
  const [areas, setAreas] = useState<DeliveryArea[]>([]);
  const [loadingAreas, setLoadingAreas] = useState(true);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryQuote | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [refused, setRefused] = useState<RefusedCartLine[]>([]);
  const [accountExists, setAccountExists] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newAttemptKey());
  // Phase 20B-1: the preview is advisory only — the checkout transaction is the
  // sole authority, so a coupon rejected there clears the applied state.
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  // PG-5 (ق-73): «اتصل قبل الوصول» · «هدية، لا تضع الفاتورة». Optional, and
  // sent only when written, so a checkout without one is unchanged.
  // CD-5: 0 unless he redeems, and the key is omitted entirely in that case so
  // a points-free checkout keeps the fingerprint it had before this feature.
  const [loyaltyPoints, setLoyaltyPoints] = useState(0);
  const [loyaltyDiscountIqd, setLoyaltyDiscountIqd] = useState(0);
  const [note, setNote] = useState("");
  const [applyingCoupon, setApplyingCoupon] = useState(false);
  // ق-201: who is buying, when nobody is signed in.
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  // ق-209: which of the merchant's switched-on methods he picked.
  const methods = config?.paymentMethods?.length ? config.paymentMethods : [CASH];
  const [paymentMethodCode, setPaymentMethodCode] = useState<string>("cod");
  useEffect(() => {
    if (!methods.some((method) => method.code === paymentMethodCode))
      setPaymentMethodCode(methods[0]!.code);
  }, [methods, paymentMethodCode]);
  const method = methods.find((entry) => entry.code === paymentMethodCode) ?? methods[0]!;
  const guestMode = !customer && Boolean(config?.guestCheckout);

  async function applyCoupon() {
    if (!couponDraft.trim() || applyingCoupon) return;
    setApplyingCoupon(true);
    setCouponError(null);
    try {
      const result = await storefrontApi.couponPreview(slug, couponDraft.trim());
      setAppliedCoupon(result.preview);
      setIdempotencyKey(newAttemptKey());
    } catch (error) {
      setAppliedCoupon(null);
      setCouponError(errorMessage(error));
    } finally {
      setApplyingCoupon(false);
    }
  }

  function clearCoupon() {
    setAppliedCoupon(null);
    setCouponDraft("");
    setCouponError(null);
    setIdempotencyKey(newAttemptKey());
  }

  const loadAddresses = useCallback(async () => {
    if (!customer) {
      setLoadingAddresses(false);
      return;
    }
    setLoadingAddresses(true);
    try {
      const result = await storefrontApi.addresses(slug);
      setAddresses(result.addresses);
      setSelectedAddressId((current) =>
        current && result.addresses.some((address) => address.id === current)
          ? current
          : (result.addresses.find((address) => address.isDefault)?.id ??
            result.addresses[0]?.id ??
            null)
      );
      setPageError(null);
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setLoadingAddresses(false);
    }
  }, [customer, slug]);

  const loadDelivery = useCallback(
    async (addressId: string | null) => {
      if (!addressId || showAddressForm || !customer) {
        setDelivery(null);
        setDeliveryError(null);
        return;
      }
      setLoadingQuote(true);
      try {
        const result = await storefrontApi.deliveryQuote(slug, addressId);
        setDelivery(result.delivery);
        setDeliveryError(null);
      } catch (error) {
        setDelivery(null);
        setDeliveryError(errorMessage(error));
      } finally {
        setLoadingQuote(false);
      }
    },
    [showAddressForm, slug, customer]
  );

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await storefrontApi.deliveryAreas(slug);
        if (!cancelled) setAreas(result.areas);
      } catch {
        // A failure here must not block the page: the shopper still has his
        // saved addresses, and checkout answers honestly if the store cannot
        // reach him.
        if (!cancelled) setAreas([]);
      } finally {
        if (!cancelled) setLoadingAreas(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);
  useEffect(() => {
    void loadDelivery(selectedAddressId);
  }, [loadDelivery, selectedAddressId]);
  // A guest's recipient phone is his own phone until he says otherwise.
  useEffect(() => {
    if (guestMode && !draft.phoneContact && guestPhone)
      setDraft((current) => ({ ...current, phoneContact: guestPhone }));
  }, [guestMode, guestPhone, draft.phoneContact]);
  useEffect(() => {
    if (guestMode && !draft.recipientName && guestName)
      setDraft((current) => ({ ...current, recipientName: guestName }));
  }, [guestMode, guestName, draft.recipientName]);

  if (storefrontLoading || (!customer && !config))
    return <LoadingState label="جارٍ تجهيز الطلب…" />;
  if (!customer && !guestMode) {
    const returnTo = encodeURIComponent(`/store/${slug}/checkout`);
    return (
      <EmptyState
        title="سجّل الدخول لإتمام الطلب"
        detail="يطلب هذا المتجر حساب زبون لإتمام الطلب."
        action={{
          label: "تسجيل الدخول",
          onClick: () => navigate(`/store/${slug}/account/login?returnTo=${returnTo}`),
        }}
      />
    );
  }
  if (!cart || !cart.items.length)
    return (
      <EmptyState
        title="سلتك فارغة"
        detail="أضف منتجاً واحداً على الأقل قبل إتمام الطلب."
        action={{ label: "تصفح المنتجات", onClick: () => navigate(`/store/${slug}/products`) }}
      />
    );

  const activeCart = cart;
  const subtotal = activeCart.items.reduce(
    (sum, item) => sum + item.quantity * item.priceSnapshotIqd,
    0
  );
  const discount = appliedCoupon?.discountIqd ?? 0;
  // ق-201: a guest's fee is read off the public area list for the governorate
  // he picked — the same number the server will charge — because the quote
  // route needs a saved address and he has none.
  const guestArea = guestMode
    ? (areas.find((area) => area.key === draft.governorate) ?? null)
    : null;
  const knownDelivery: DeliveryQuote | null = guestMode
    ? guestArea
      ? { governorate: guestArea.name, amountIqd: guestArea.amountIqd }
      : null
    : delivery;
  const effectiveDeliveryFee = appliedCoupon?.freeShipping ? 0 : (knownDelivery?.amountIqd ?? 0);
  // CD-5: the page must show the SAME total the server will compute, or the
  // shopper is surprised at the last step. The server caps the redemption at
  // what is left to pay for goods, so this cap mirrors it exactly.
  const payableForGoods = Math.max(0, subtotal - discount);
  const loyaltyDiscount = customer ? Math.min(loyaltyDiscountIqd, payableForGoods) : 0;
  const total = subtotal - discount - loyaltyDiscount + effectiveDeliveryFee;
  const addressComplete = Boolean(
    draft.recipientName.trim() &&
      draft.fullAddress.trim() &&
      draft.city.trim() &&
      draft.governorate.trim() &&
      draft.phoneContact.trim()
  );

  function afterOrder(
    order: { id: string; orderNumber: string; totalIqd: number },
    replayed: boolean
  ) {
    // Phase 20B-3 (D-26): Purchase fires ONLY for a freshly created order —
    // an idempotent replay (result.replayed) must never double-count.
    if (!replayed) trackPurchase(order.totalIqd, order.orderNumber);
    setNotice(
      replayed
        ? "تم استعادة نتيجة طلب سابق؛ لم يُنشأ طلب إضافي."
        : method.kind === "manual_transfer"
          ? `تم إنشاء الطلب. حوّل المبلغ إلى ${method.displayName} وسيؤكد المتجر استلامه.`
          : "تم إنشاء الطلب بنجاح. الدفع عند الاستلام."
    );
    navigate(`/store/${slug}/account/orders/${order.id}`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setPageError(null);
    setAccountExists(false);
    setSubmitting(true);
    try {
      if (guestMode) {
        if (!guestName.trim() || !guestPhone.trim()) throw new Error("اكتب اسمك ورقم هاتفك.");
        if (!addressComplete) throw new Error("أكمل جميع حقول عنوان التسليم.");
        const result = await storefrontApi.guestCheckout(slug, {
          cartVersion: activeCart.version,
          fullName: guestName.trim(),
          phone: guestPhone.trim(),
          email: guestEmail.trim() || undefined,
          address: {
            recipientName: draft.recipientName.trim(),
            fullAddress: draft.fullAddress.trim(),
            city: draft.city.trim(),
            governorate: draft.governorate.trim(),
            phoneContact: draft.phoneContact.trim(),
          },
          paymentMethodCode,
          idempotencyKey,
          couponCode: appliedCoupon?.code,
          note: note.trim() || undefined,
        });
        await refreshCart().catch(() => undefined);
        if (result.account) {
          // A row this checkout created: the server issued a session for it.
          setCustomer(result.account);
          afterOrder(result.order, result.replayed);
          return;
        }
        // ق-232: his number already has orders here, and a number proves
        // nothing about who typed it — so no session, and the confirmation is
        // the public tracking page, prefilled with the order he just placed.
        if (!result.replayed) trackPurchase(result.order.totalIqd, result.order.orderNumber);
        setNotice(
          `تم إنشاء الطلب ${result.order.orderNumber}. تابعه من «أين طلبي؟» برقم الطلب ورقم هاتفك.`
        );
        navigate(`/store/${slug}/track?order=${encodeURIComponent(result.order.orderNumber)}`);
        return;
      }
      let addressId = selectedAddressId;
      if (showAddressForm) {
        if (!addressComplete) throw new Error("أكمل جميع حقول عنوان التسليم.");
        const created = await storefrontApi.addAddress(slug, {
          ...draft,
          recipientName: draft.recipientName.trim(),
          fullAddress: draft.fullAddress.trim(),
          city: draft.city.trim(),
          governorate: draft.governorate.trim(),
          phoneContact: draft.phoneContact.trim(),
          isDefault: addresses.length === 0,
        });
        addressId = created.address.id;
        setAddresses((current) => [created.address, ...current]);
        setSelectedAddressId(addressId);
        setShowAddressForm(false);
        await loadDelivery(addressId);
        setNotice("تم حفظ العنوان وحساب رسوم التوصيل. راجع الملخص ثم أكّد الطلب.");
        return;
      }
      if (!addressId) throw new Error("اختر عنوان تسليم أو أضف عنواناً جديداً.");
      if (!delivery) throw new Error(deliveryError ?? "جارٍ حساب رسوم التوصيل للعنوان المختار.");
      const result = await storefrontApi.checkout(slug, {
        cartVersion: activeCart.version,
        addressId,
        paymentMethodCode,
        idempotencyKey,
        couponCode: appliedCoupon?.code,
        note: note.trim() || undefined,
        ...(loyaltyPoints > 0 ? { loyaltyPoints } : {}),
      });
      await refreshCart();
      afterOrder(result.order, result.replayed);
    } catch (error) {
      // 19-د: CART_PRICE_CHANGED belongs with these two — the server has already
      // written the live prices onto the cart, so refreshing shows the shopper
      // what he will actually pay and the next tap goes through. A stale
      // idempotency key would otherwise answer IDEMPOTENCY_KEY_REUSED on that
      // second tap, because the corrected cart carries a new version.
      if (
        error instanceof StorefrontApiError &&
        ["CART_VERSION_CONFLICT", "CART_ALREADY_CHECKED_OUT", "CART_PRICE_CHANGED"].includes(
          error.code
        )
      ) {
        await refreshCart().catch(() => undefined);
        setIdempotencyKey(newAttemptKey());
      }
      // The transaction refused the coupon: drop the advisory preview so the
      // customer retries without it (or with a corrected code) under a new key.
      if (error instanceof StorefrontApiError && error.code.startsWith("COUPON")) {
        setAppliedCoupon(null);
        setCouponError(errorMessage(error));
        setIdempotencyKey(newAttemptKey());
      }
      // ق-201: his phone is somebody's account — his own, most likely. Offer the door.
      if (error instanceof StorefrontApiError && error.code === "CUSTOMER_ACCOUNT_EXISTS")
        setAccountExists(true);
      // ق-221: the server names every line it refused; the shopper sees which.
      setRefused(refusedLines(error));
      setPageError(
        error instanceof Error && !(error instanceof StorefrontApiError)
          ? error.message
          : errorMessage(error)
      );
    } finally {
      setSubmitting(false);
    }
  }

  const card =
    "rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6";
  const heading = "font-black text-[var(--codiq-text)]";
  const canSubmit = guestMode
    ? Boolean(guestName.trim() && guestPhone.trim() && addressComplete && knownDelivery)
    : showAddressForm
      ? true
      : Boolean(selectedAddressId && delivery);

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-bold text-[var(--codiq-accent)]">إتمام الطلب</p>
        <h1 className="mt-1 text-2xl font-black text-[var(--codiq-text)] sm:text-3xl">
          تأكيد الطلب
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
          يحجز الخادم الكميات ويتحقق من السلة ورسوم التوصيل عند التأكيد.
        </p>
      </div>
      {pageError ? (
        <div className="space-y-2">
          <ErrorState
            message={pageError}
            retry={customer ? () => void loadAddresses() : undefined}
          />
          {refused.length ? (
            <ul
              data-testid="checkout-refused-lines"
              className="space-y-1.5 rounded-2xl border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-4 text-sm text-[var(--storefront-text)]"
            >
              {refused.map((line) => (
                <li
                  key={line.cartItemId}
                  className="flex flex-wrap items-baseline justify-between gap-2"
                >
                  <span className="font-bold">
                    {line.productName ?? "منتج لم يعد متاحاً"}
                    {line.variantName ? (
                      <span className="font-semibold text-[var(--storefront-muted)]">
                        {" "}
                        — {line.variantName}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-[var(--storefront-muted)]">
                    {line.reason === "unavailable"
                      ? "لم يعد متاحاً"
                      : line.reason === "order_limit"
                        ? `الحدّ الأقصى ${line.available} لكل طلب`
                        : line.available === 0
                          ? "نفد المخزون"
                          : `طلبت ${line.requested} والمتاح ${line.available}`}
                  </span>
                </li>
              ))}
              <li className="pt-1">
                <Link
                  href={`/store/${slug}/cart`}
                  className="text-xs font-bold text-[var(--storefront-accent)] hover:underline"
                >
                  عدّل السلة
                </Link>
              </li>
            </ul>
          ) : null}
          {accountExists ? (
            <Link
              href={`/store/${slug}/account/login?returnTo=${encodeURIComponent(`/store/${slug}/checkout`)}`}
              className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--codiq-accent)] hover:underline"
            >
              <UserRound className="h-4 w-4" />
              سجّل الدخول بهذا الرقم لإتمام الطلب
            </Link>
          ) : null}
        </div>
      ) : null}
      <form
        className="grid gap-6 lg:grid-cols-[1fr_360px]"
        onSubmit={(event) => void submit(event)}
      >
        <div className="space-y-4">
          {guestMode ? (
            <section className={card} data-testid="guest-checkout">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <UserRound className="h-5 w-5 text-[var(--codiq-accent)]" />
                  <h2 className={heading}>بياناتك</h2>
                </div>
                <Link
                  href={`/store/${slug}/account/login?returnTo=${encodeURIComponent(`/store/${slug}/checkout`)}`}
                  data-testid="guest-login-link"
                  className="text-sm font-bold text-[var(--codiq-accent)] hover:underline"
                >
                  لديك حساب؟ سجّل الدخول
                </Link>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm font-bold text-[var(--codiq-text-secondary)]">
                  الاسم الكامل
                  <Input
                    data-testid="guest-name"
                    value={guestName}
                    onChange={(event) => setGuestName(event.target.value)}
                    autoComplete="name"
                    required
                    className="h-11 rounded-xl"
                  />
                </label>
                <label className="space-y-2 text-sm font-bold text-[var(--codiq-text-secondary)]">
                  رقم الهاتف
                  <Input
                    data-testid="guest-phone"
                    value={guestPhone}
                    onChange={(event) => setGuestPhone(event.target.value)}
                    inputMode="tel"
                    autoComplete="tel"
                    dir="ltr"
                    placeholder="07XXXXXXXXX"
                    required
                    className="h-11 rounded-xl text-left"
                  />
                </label>
                <label className="space-y-2 text-sm font-bold text-[var(--codiq-text-secondary)] sm:col-span-2">
                  البريد الإلكتروني{" "}
                  <span className="text-xs font-semibold text-[var(--codiq-text-muted)]">
                    (اختياري — لتصلك تأكيدات الطلب)
                  </span>
                  <Input
                    data-testid="guest-email"
                    type="email"
                    value={guestEmail}
                    onChange={(event) => setGuestEmail(event.target.value)}
                    autoComplete="email"
                    dir="ltr"
                    className="h-11 rounded-xl text-left"
                  />
                </label>
              </div>
              <p className="mt-3 text-xs leading-6 text-[var(--codiq-text-muted)]">
                لا يلزم إنشاء حساب. بعد الطلب يمكنك اختيار كلمة مرور لحفظ طلباتك تحت رقمك.
              </p>
            </section>
          ) : null}
          <section className={card}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-[var(--codiq-accent)]" />
                <h2 className={heading}>عنوان التسليم</h2>
              </div>
              {customer ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="font-bold text-[var(--codiq-accent)]"
                  onClick={() => {
                    setShowAddressForm((visible) => !visible);
                    setPageError(null);
                  }}
                >
                  <Plus className="ml-1 h-4 w-4" />
                  {showAddressForm ? "استخدام عنوان محفوظ" : "عنوان جديد"}
                </Button>
              ) : null}
            </div>
            {guestMode || showAddressForm ? (
              <div className="mt-5">
                <AddressForm
                  idPrefix="checkout"
                  draft={draft}
                  onChange={setDraft}
                  areas={areas}
                  loadingAreas={loadingAreas}
                />
              </div>
            ) : loadingAddresses ? (
              <div className="mt-5">
                <LoadingState label="جارٍ تحميل العناوين…" />
              </div>
            ) : addresses.length ? (
              <fieldset className="mt-5 space-y-3">
                <legend className="sr-only">اختر عنوان التسليم</legend>
                {addresses.map((address) => (
                  <label
                    key={address.id}
                    className={`flex cursor-pointer gap-3 rounded-2xl border p-4 transition ${selectedAddressId === address.id ? "border-[var(--codiq-accent)] bg-[var(--codiq-canvas)]" : "border-[var(--codiq-border)] hover:border-[var(--codiq-border-strong)]"}`}
                  >
                    <input
                      type="radio"
                      name="address"
                      value={address.id}
                      checked={selectedAddressId === address.id}
                      onChange={() => setSelectedAddressId(address.id)}
                      className="mt-1 h-4 w-4 accent-[var(--codiq-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 font-black text-[var(--codiq-text)]">
                        {address.recipientName}
                        {address.isDefault ? (
                          <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--codiq-accent)]">
                            افتراضي
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-[var(--codiq-text-muted)]">
                        {address.fullAddress}، {address.city}، {address.governorate}
                      </span>
                      <span
                        className="mt-1 block text-xs font-bold text-[var(--codiq-text-secondary)]"
                        dir="ltr"
                      >
                        {address.phoneContactNormalized}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="mt-5 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 text-sm leading-6 text-[var(--codiq-text-secondary)]">
                لا يوجد عنوان محفوظ. اختر «عنوان جديد» لإضافة عنوان التسليم.
              </div>
            )}
          </section>
          <section className={card} data-testid="payment-method">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-[var(--codiq-accent)]" />
              <h2 className={heading}>طريقة الدفع</h2>
            </div>
            {methods.length <= 1 ? (
              <div className="mt-4 flex items-center gap-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 text-sm">
                <Banknote className="h-5 w-5 text-[var(--codiq-success)]" />
                <span className="font-bold text-[var(--codiq-text)]">{method.displayName}</span>
                <span className="text-xs text-[var(--codiq-text-muted)]">
                  {method.kind === "cod"
                    ? "تدفع نقداً للمندوب عند التسليم."
                    : "تحويل يدوي قبل التسليم."}
                </span>
              </div>
            ) : (
              <fieldset className="mt-4 space-y-3">
                <legend className="sr-only">اختر طريقة الدفع</legend>
                {methods.map((entry) => (
                  <label
                    key={entry.code}
                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-4 transition ${paymentMethodCode === entry.code ? "border-[var(--codiq-accent)] bg-[var(--codiq-canvas)]" : "border-[var(--codiq-border)] hover:border-[var(--codiq-border-strong)]"}`}
                  >
                    <input
                      type="radio"
                      name="paymentMethod"
                      value={entry.code}
                      checked={paymentMethodCode === entry.code}
                      onChange={() => setPaymentMethodCode(entry.code)}
                      className="h-4 w-4 accent-[var(--codiq-accent)]"
                    />
                    {entry.kind === "cod" ? (
                      <Banknote className="h-5 w-5 text-[var(--codiq-success)]" />
                    ) : (
                      <Wallet className="h-5 w-5 text-[var(--codiq-accent)]" />
                    )}
                    <span className="min-w-0">
                      <span className="block font-bold text-[var(--codiq-text)]">
                        {entry.displayName}
                      </span>
                      <span className="block text-xs text-[var(--codiq-text-muted)]">
                        {entry.kind === "cod"
                          ? "تدفع نقداً للمندوب عند التسليم."
                          : "تحوّل المبلغ قبل التسليم ويؤكد المتجر استلامه."}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {method.kind === "manual_transfer" ? (
              <div
                data-testid="transfer-instructions"
                className="mt-4 rounded-2xl bg-[var(--codiq-accent-soft)] p-4 text-sm leading-7 text-[var(--codiq-text)]"
              >
                <p>حوّل المبلغ الإجمالي إلى {method.displayName}:</p>
                {method.walletNumber ? (
                  <p className="text-lg font-black tabular-nums" dir="ltr">
                    {method.walletNumber}
                  </p>
                ) : null}
                {method.holderName ? (
                  <p>
                    باسم: <span className="font-bold">{method.holderName}</span>
                  </p>
                ) : null}
                {method.instructions ? (
                  <p className="text-[var(--codiq-text-secondary)]">{method.instructions}</p>
                ) : null}
                <p className="text-xs text-[var(--codiq-text-muted)]">
                  يبقى الطلب «بانتظار التحويل» حتى يؤكد المتجر استلام المبلغ.
                </p>
              </div>
            ) : null}
          </section>
          <section className={card}>
            <label htmlFor="checkout-note" className={heading}>
              ملاحظة للتوصيل{" "}
              <span className="text-xs font-bold text-[var(--codiq-text-muted)]">(اختياري)</span>
            </label>
            <p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">
              مثل: اتصل قبل الوصول · الشقة فوق الصيدلية · هدية، لا تضع الفاتورة.
            </p>
            <textarea
              id="checkout-note"
              data-testid="checkout-note"
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 500))}
              rows={3}
              maxLength={500}
              className="mt-3 w-full resize-y rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm leading-6 text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
              placeholder="اكتب ما يحتاج المندوب معرفته…"
            />
            <p className="mt-1 text-left text-[11px] text-[var(--codiq-text-muted)]" dir="ltr">
              {note.length}/500
            </p>
          </section>
        </div>
        <aside className="h-fit rounded-[26px] bg-[var(--codiq-accent-strong)] p-6 text-white shadow-lg">
          <div className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5" />
            <h2 className="font-black">ملخص الطلب</h2>
          </div>
          <ul className="mt-5 space-y-3 border-b border-white/15 pb-5 text-sm">
            {activeCart.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-4">
                <span className="line-clamp-1">
                  {item.product?.name ?? "منتج"} × {item.quantity}
                </span>
                <span className="shrink-0 font-bold tabular-nums">
                  {formatIqd.format(item.priceSnapshotIqd * item.quantity)} د.ع
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-5 rounded-2xl bg-white/10 p-3">
            <label
              htmlFor="checkout-coupon"
              className="flex items-center gap-1.5 text-xs font-bold text-white/85"
            >
              <TicketPercent className="h-4 w-4" />
              كوبون خصم
            </label>
            {appliedCoupon ? (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-white/15 px-3 py-2 text-sm">
                <span className="font-black">{appliedCoupon.code}</span>
                <span className="text-xs">
                  {appliedCoupon.freeShipping
                    ? "شحن مجاني"
                    : `خصم ${formatIqd.format(appliedCoupon.discountIqd)} د.ع`}
                </span>
                <button
                  type="button"
                  onClick={clearCoupon}
                  aria-label="إزالة الكوبون"
                  className="rounded-full p-1 hover:bg-white/20"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <input
                  id="checkout-coupon"
                  value={couponDraft}
                  onChange={(event) => setCouponDraft(event.target.value)}
                  placeholder="أدخل رمز الكوبون"
                  className="h-10 min-w-0 flex-1 rounded-xl border-0 bg-white/90 px-3 text-sm text-[var(--codiq-text)] outline-none placeholder:text-[var(--codiq-text-muted)]"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={applyingCoupon || !couponDraft.trim()}
                  onClick={() => void applyCoupon()}
                  className="h-10 rounded-xl bg-white/25 px-3 font-bold text-white hover:bg-white/35"
                >
                  {applyingCoupon ? "جارٍ التحقق…" : "تطبيق"}
                </Button>
              </div>
            )}
            {couponError ? (
              <p role="alert" className="mt-2 text-xs leading-5 text-amber-100">
                {couponError}
              </p>
            ) : appliedCoupon ? (
              <p className="mt-2 text-[11px] leading-5 text-white/70">
                يُعاد التحقق النهائي من الكوبون عند تأكيد الطلب.
              </p>
            ) : null}
          </div>
          {customer ? (
            <LoyaltyRedeem
              slug={slug}
              payableForGoodsIqd={payableForGoods}
              onChange={setLoyaltyPoints}
              onDiscount={setLoyaltyDiscountIqd}
            />
          ) : null}
          <div className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between">
              <span>إجمالي المنتجات</span>
              <strong className="tabular-nums">{formatIqd.format(subtotal)} د.ع</strong>
            </div>
            {discount > 0 ? (
              <div className="flex justify-between text-emerald-200">
                <span>الخصم ({appliedCoupon?.code})</span>
                <strong className="tabular-nums">-{formatIqd.format(discount)} د.ع</strong>
              </div>
            ) : null}
            {loyaltyDiscount > 0 ? (
              <div className="flex justify-between text-emerald-200">
                <span>خصم النقاط</span>
                <strong className="tabular-nums">-{formatIqd.format(loyaltyDiscount)} د.ع</strong>
              </div>
            ) : null}
            <div className="flex justify-between">
              <span className="flex items-center gap-1.5">
                <Truck className="h-4 w-4" />
                التوصيل{knownDelivery ? ` — ${knownDelivery.governorate}` : ""}
              </span>
              <strong className="tabular-nums">
                {loadingQuote
                  ? "جارٍ الحساب…"
                  : appliedCoupon?.freeShipping && knownDelivery
                    ? "مجاني"
                    : knownDelivery
                      ? `${formatIqd.format(knownDelivery.amountIqd)} د.ع`
                      : guestMode
                        ? "اختر المحافظة"
                        : "غير متاح"}
              </strong>
            </div>
          </div>
          {deliveryError ? (
            <p
              role="alert"
              className="mt-4 rounded-xl bg-amber-100/15 p-3 text-xs leading-5 text-amber-50"
            >
              {deliveryError}
            </p>
          ) : null}
          <div className="mt-5 flex justify-between border-t border-white/15 pt-5 text-base">
            <span>الإجمالي النهائي</span>
            <strong className="tabular-nums">{formatIqd.format(total)} د.ع</strong>
          </div>
          <div className="mt-5 flex gap-2 rounded-2xl bg-white/10 p-3 text-xs leading-5 text-white/85">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            تُلتقط رسوم التوصيل في الطلب عند التأكيد، وتحمي محاولة التأكيد نفسها بمفتاح يمنع إنشاء
            طلب مكرر.
          </div>
          <Button
            type="submit"
            data-testid="checkout-submit"
            disabled={submitting || loadingAddresses || loadingQuote || !canSubmit}
            className="mt-5 h-12 w-full rounded-xl bg-[var(--codiq-surface)] font-black text-[var(--codiq-accent-strong)] hover:bg-[var(--codiq-accent-soft)]"
          >
            <CheckCircle2 className="ml-2 h-4 w-4" />
            {submitting
              ? "جارٍ تأكيد الطلب…"
              : !guestMode && showAddressForm
                ? "حفظ العنوان وحساب التوصيل"
                : `تأكيد الطلب — ${method.displayName}`}
          </Button>
          {config?.policies?.length ? (
            <p className="mt-3 text-center text-[11px] leading-5 text-white/70">
              بتأكيد الطلب أنت توافق على{" "}
              {config.policies.map((kind, index) => (
                <span key={kind}>
                  {index ? " و" : ""}
                  <Link
                    href={`/store/${slug}/policies/${kind}`}
                    className="underline hover:text-white"
                  >
                    {POLICY_LABELS[kind]}
                  </Link>
                </span>
              ))}
              .
            </p>
          ) : null}
          <Link
            href={`/store/${slug}/cart`}
            className="mt-4 flex items-center justify-center gap-2 text-sm font-bold text-white/80 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            العودة إلى السلة
          </Link>
        </aside>
      </form>
    </section>
  );
}
