export type ApiErrorCode =
  | "CUSTOMER_SESSION_REQUIRED"
  | "INVALID_CUSTOMER_CREDENTIALS"
  | "INVALID_CART_QUANTITY"
  | "CART_EMPTY"
  | "INVALID_ADDRESS"
  | "PAYMENT_METHOD_NOT_SUPPORTED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CART_VERSION_CONFLICT"
  | "CART_ALREADY_CHECKED_OUT"
  // 19-د: a cart line's price no longer matches the live product. The server has
  // already written the true price onto the cart, so a refresh shows the shopper
  // what he will pay and his next tap goes through.
  | "CART_PRICE_CHANGED"
  | "PRODUCT_UNAVAILABLE"
  | "INSUFFICIENT_AVAILABLE_STOCK"
  | "DELIVERY_UNAVAILABLE_FOR_GOVERNORATE"
  | "RATE_LIMITED"
  | "RESOURCE_NOT_FOUND"
  | "STORE_BOUNDARY_DENIED"
  | "INVALID_COUPON_CODE"
  | "COUPON_INVALID"
  | "COUPON_EXPIRED"
  | "COUPON_MIN_SUBTOTAL_NOT_MET"
  | "COUPON_EXHAUSTED"
  | "COUPON_CUSTOMER_LIMIT_REACHED"
  | "PRESCRIPTION_NOT_REQUIRED"
  | "PRESCRIPTION_ALREADY_SUBMITTED"
  | "INVALID_PRESCRIPTION_IMAGE"
  | "PRESCRIPTION_NOT_APPROVED"
  // CD-1a: the public tracking form rejects a missing order number or phone.
  | "INVALID_TRACKING_REQUEST"
  // PG-1: the store already accepted the order, so it is past self-cancellation.
  | "ORDER_NOT_CANCELLABLE"
  | "INVALID_CANCELLATION_REASON"
  // MD-1: the store is temporarily closed for new orders (browsing stays open).
  | "STORE_ON_VACATION"
  // ق-249: the store is closed for maintenance; a capability the platform switched off.
  | "STORE_IN_MAINTENANCE"
  | "CAPABILITY_UNAVAILABLE"
  // ق-201: buying without an account.
  | "GUEST_CHECKOUT_DISABLED"
  | "CUSTOMER_ACCOUNT_EXISTS"
  | "EMAIL_TAKEN"
  | "INVALID_FULL_NAME"
  | "INVALID_PHONE"
  | "ACCOUNT_HAS_PASSWORD"
  | "INVALID_PRODUCT_SORT"
  | "INVALID_CURSOR"
  // ق-216: the shop reached its plan's monthly order ceiling. The shopper is
  // told the shop is not taking orders — never that HE should upgrade a
  // subscription he does not have.
  | "STORE_NOT_ACCEPTING_ORDERS"
  | "UNKNOWN";

/** ق-221: one cart line the server refused, in the words the shopper needs to fix it. */
export type RefusedCartLine = {
  cartItemId: string;
  variantId: string;
  productName: string | null;
  variantName: string | null;
  requested: number;
  available: number;
  reason: "unavailable" | "insufficient_stock" | "order_limit";
};

export class StorefrontApiError extends Error {
  /** Whatever the server merged into its `error` object beside code and message (PG-2 `details`). */
  readonly details: Record<string, unknown>;
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.details = details ?? {};
  }
}

export type StorefrontProduct = {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  priceIqd: number;
  // Phase 20A: variant-level pricing surfaces as a min–max range on listings.
  minPriceIqd?: number;
  maxPriceIqd?: number;
  // ق-200: the parent pointer feeds the breadcrumb; nothing else changes.
  category?: { id: string; name: string; parentCategoryId?: string | null } | null;
  image?: { id: string; sortOrder: number } | null;
  // Phase 20B-1: the storefront shows a prescription badge on flagged products.
  requiresPrescription?: boolean;
  isAvailable: boolean;
  /** Audit 12-أ: more than one active variant — the card links to the product page instead of adding the default. */
  hasOptions?: boolean;
  // ق-200: the «جديد» badge is an age threshold over this, computed on the client.
  createdAt?: string;
};
// Phase 20A: each active variant reports its own availability without exposing
// raw stock quantities to the public storefront.
export type ProductVariantOption = {
  id: string;
  name: string;
  sku: string;
  priceIqd: number;
  options: Record<string, unknown>;
  position: number;
  isDefault: boolean;
  isAvailable: boolean;
};
/** ق-199: a typed attribute group — the merchant's own vocabulary («النوتة العطرية»: مقدمة / قلب / قاعدة). */
export type ProductAttributeGroup = { group: string; rows: Array<{ key: string; value: string }> };
export type ProductDetail = StorefrontProduct & {
  images: Array<{ id: string; contentType: string; byteSize: number; sortOrder: number }>;
  isActive: boolean;
  variants?: ProductVariantOption[];
  attributes?: ProductAttributeGroup[];
  // ق-200: the star row rides the product fetch.
  rating?: { average: number | null; count: number };
};
export type StorefrontCategory = { id: string; name: string; parentCategoryId?: string | null };
export type CartItem = {
  id: string;
  productId: string;
  variantId?: string;
  quantity: number;
  priceSnapshotIqd: number;
  product: {
    id: string;
    name: string;
    sku: string;
    isActive: boolean;
    priceIqd: number;
    stockQuantity: number;
    image?: { id: string } | null;
  } | null;
  variant?: {
    id: string;
    name: string;
    sku: string;
    isActive: boolean;
    priceIqd: number;
    isDefault: boolean;
  } | null;
};
export type Cart = {
  id: string | null;
  status: "active" | "merged" | "converted" | "expired" | "empty";
  version: number;
  expiresAt: string | null;
  ownerKind: "guest" | "customer";
  items: CartItem[];
};
// ق-201: `isGuest` — a shopper who bought without choosing a password; the
// shell offers him one instead of an account menu he cannot sign back into.
export type Customer = {
  id: string;
  storeId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  phoneNormalized?: string | null;
  isGuest?: boolean;
};

/** ق-199: a front-page section the merchant switched on, in his order, under his title. */
export type HomeSectionKey =
  | "banners"
  | "categories"
  | "newest"
  | "best_selling"
  | "banners_mid"
  | "top_rated"
  | "reviews";
export type HomeSection = { key: HomeSectionKey; enabled: boolean; title: string };
/** ق-209: a payment method the merchant switched on — with what a wallet transfer needs the shopper to know. */
export type PublicPaymentMethod = {
  code: string;
  displayName: string;
  kind: "cod" | "manual_transfer" | "gateway";
  walletNumber?: string;
  holderName?: string;
  instructions?: string;
};
export type PolicyKind = "return" | "privacy" | "delivery";
/**
 * ق-199: everything the merchant owns about his shop's face, in ONE payload.
 * Optional keys are ABSENT — not null — when there is nothing to say.
 */
export type StorefrontConfig = {
  storeSlug: string;
  name: string;
  logoUrl?: string;
  headline?: string;
  subline?: string;
  announcement?: { text: string };
  contact?: {
    email?: string;
    phone?: string;
    whatsapp?: string;
    addressLine?: string;
    city?: string;
  };
  social?: {
    facebook?: string;
    instagram?: string;
    x?: string;
    tiktok?: string;
    snapchat?: string;
    youtube?: string;
  };
  policies?: PolicyKind[];
  /** ق-211: the merchant's own footer pages — the link list; the body is one request away. */
  pages?: { slug: string; title: string }[];
  paymentMethods: PublicPaymentMethod[];
  guestCheckout: boolean;
  homeSections: HomeSection[];
  pixels?: { metaPixelId?: string; tiktokPixelId?: string; ga4MeasurementId?: string };
  vacation?: { message: string };
  /** ق-249: always present — the shell never guesses whether the store is open. */
  availability: {
    store: {
      status: "active" | "paused" | "maintenance" | "suspended" | "closed";
      message?: string;
      until?: string;
    };
    /** ق-250: a platform-wide maintenance window running now — a strip in every shop's shell. */
    platform?: { maintenance?: { message: string; until: string } };
  };
  verified?: { verifiedAt: string };
};
/** ق-210: `placement` says which of the front page's two sliders this slide belongs to. */
export type BannerPlacement = "hero" | "mid";
export type StoreBanner = {
  id: string;
  url: string;
  linkUrl: string | null;
  altText: string | null;
  isActive: boolean;
  sortOrder: number;
  placement: BannerPlacement;
};
export type StoreReview = {
  id: string;
  rating: number;
  body: string;
  author: string;
  createdAt: string;
  product: { id: string; name: string };
};
export type RelatedProduct = {
  productId: string;
  name: string;
  priceIqd: number;
  imageId: string | null;
};
export type ProductSort = "newest" | "best_selling" | "top_rated";
export type Address = {
  id: string;
  recipientName: string;
  fullAddress: string;
  city: string;
  governorate: string;
  phoneContactNormalized: string;
  isDefault: boolean;
  createdAt: string;
};
export type DeliveryQuote = { governorate: string; amountIqd: number };
export type OrderListItem = {
  id: string;
  orderNumber: string;
  status: string;
  totalIqd: number;
  createdAt: string;
  statusUpdatedAt: string;
};
export type PrescriptionStatus = "pending_upload" | "pending_review" | "approved" | "rejected";
export type CouponPreview = {
  code: string;
  kind: "percent" | "fixed" | "free_shipping";
  discountIqd: number;
  freeShipping: boolean;
};
// ق-205: every money term the server stores reaches this type — the shopper's
// own order page must add up exactly as the merchant's does (ق-187, mirrored).
export type CustomerOrder = OrderListItem & {
  subtotalIqd: number;
  deliveryFeeIqd: number;
  discountIqd: number;
  loyaltyPointsSpent: number;
  loyaltyDiscountIqd: number;
  platformDiscountIqd?: number;
  couponCode?: string | null;
  customerNote?: string | null;
  prescriptionStatus?: PrescriptionStatus | null;
  items: Array<{
    id: string;
    productName: string;
    sku: string;
    quantity: number;
    unitPriceIqd: number;
    lineTotalIqd: number;
  }>;
  statusEvents: TimelineEvent[];
  customerName: string;
  recipientPhone: string;
  shippingGovernorate: string;
  shippingAddressLine1: string;
  shippingAddressLine2?: string | null;
};
export type TimelineEvent = { fromStatus: string | null; toStatus: string; createdAt: string };
// CD-1a: the PUBLIC tracking projection — deliberately carries no customer
// identity (no name, email, phone, or address lines) and a timeline reduced to
// the transition plus its time. Keep this type in lockstep with the server's
// ORDER_TRACKING_KEYS allow-list.
export type TrackedTimelineEvent = { toStatus: string; createdAt: string };
export type TrackedOrder = {
  orderNumber: string;
  status: string;
  statusTimeline: TrackedTimelineEvent[];
  itemCount: number;
  totalIqd: number;
  governorate: string | null;
  createdAt: string;
};
// CD-1c: one-click reorder is best-effort — every line that could not be added
// comes back here with an honest reason.
export type ReorderSkipReason = "product_unavailable" | "insufficient_stock" | "quantity_limit";
export type ReorderSkip = {
  productName: string;
  variantName: string | null;
  reason: ReorderSkipReason;
};

function path(...segments: string[]) {
  return `/api/store/${segments.map(encodeURIComponent).join("/").replace(/%2F/g, "/")}`;
}

/** ق-251: what applies to this customer and who decided it. */
export type CustomerPreferenceEntry = {
  value: number | boolean;
  source: "default" | "platform" | "plan" | "merchant" | "store" | "customer";
  sourceLabel: string;
};
export type CustomerPreferences = {
  marketingOptIn: CustomerPreferenceEntry;
  guestCheckout: CustomerPreferenceEntry;
  loyalty: CustomerPreferenceEntry;
};

export async function storefrontRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // JSON content type applies to string bodies only — a FormData body (the
    // prescription upload) must keep its browser-set multipart boundary.
    response = await fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new StorefrontApiError(
      0,
      "UNKNOWN",
      "تعذر الاتصال بالخادم. تحقق من الشبكة ثم حاول مجددًا."
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { code?: string; message?: string } & Record<string, unknown> })
            .error
        : undefined;
    const { code, message, requestId: _requestId, ...details } = error ?? {};
    throw new StorefrontApiError(
      response.status,
      (code as ApiErrorCode) ?? "UNKNOWN",
      message ?? "تعذر إتمام الطلب.",
      details
    );
  }
  return payload as T;
}

export const storefrontApi = {
  // ق-200: `sort` picks a rail and `limit` lets a rail ask for a handful
  // instead of over-fetching a page it will cut.
  listProducts: (
    slug: string,
    filters: { categoryId?: string; query?: string; sort?: ProductSort; limit?: number } = {},
    cursor?: string | null
  ) => {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 12) });
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    if (filters.query) params.set("q", filters.query);
    if (filters.sort && filters.sort !== "newest") params.set("sort", filters.sort);
    if (cursor) params.set("cursor", cursor);
    return storefrontRequest<{ products: StorefrontProduct[]; nextCursor: string | null }>(
      `${path(slug, "products")}?${params.toString()}`
    );
  },
  categories: (slug: string) =>
    storefrontRequest<{ categories: StorefrontCategory[] }>(path(slug, "categories")),
  // ق-198: the merchant's own front-page slides, live ones only, in his order.
  banners: (slug: string) => storefrontRequest<{ banners: StoreBanner[] }>(path(slug, "banners")),
  // ق-200: the store-wide public review feed — shopper-visible rows only.
  storeReviews: (slug: string, limit = 8) =>
    storefrontRequest<{ reviews: StoreReview[] }>(`${path(slug, "reviews")}?limit=${limit}`),
  // ق-200: same-category siblings — «عناصر قد تعجبك», no evidence claimed.
  related: (slug: string, productId: string) =>
    storefrontRequest<{ related: RelatedProduct[] }>(path(slug, "products", productId, "related")),
  // ق-199: one of the store's written policies.
  policy: (slug: string, kind: PolicyKind) =>
    storefrontRequest<{ policy: { kind: PolicyKind; title: string; body: string } }>(
      path(slug, "policies", kind)
    ),
  // ق-211: one of the merchant's own footer pages, by its slug.
  page: (slug: string, pageSlug: string) =>
    storefrontRequest<{ page: { slug: string; title: string; body: string } }>(
      path(slug, "pages", pageSlug)
    ),
  // ق-202: the visit beacon — fire-and-forget, never awaited by a screen.
  visit: (slug: string, productId?: string) =>
    storefrontRequest<void>(path(slug, "visit"), {
      method: "POST",
      body: JSON.stringify(productId ? { productId } : {}),
      keepalive: true,
    }).catch(() => undefined),
  // ق-201: buying without an account. ق-232: the server issues a customer
  // session — and returns `account` — ONLY for a shadow row this checkout
  // created; a phone that already has history here gets the order and nothing
  // else, because the number was never proof of the person. `account: null`
  // therefore means «track it by order number and phone», not an error.
  guestCheckout: (
    slug: string,
    body: {
      cartVersion: number;
      fullName: string;
      phone: string;
      email?: string;
      address: {
        recipientName: string;
        fullAddress: string;
        city: string;
        governorate: string;
        phoneContact: string;
      };
      paymentMethodCode: string;
      idempotencyKey: string;
      couponCode?: string;
      note?: string;
    }
  ) =>
    storefrontRequest<{
      order: CustomerOrder;
      replayed: boolean;
      account: Customer | null;
      accessToken: string | null;
    }>(path(slug, "checkout", "guest"), {
      method: "POST",
      headers: { "Idempotency-Key": body.idempotencyKey },
      body: JSON.stringify({
        cartVersion: body.cartVersion,
        fullName: body.fullName,
        phone: body.phone,
        ...(body.email ? { email: body.email } : {}),
        address: body.address,
        paymentMethodCode: body.paymentMethodCode,
        ...(body.couponCode ? { couponCode: body.couponCode } : {}),
        ...(body.note ? { note: body.note } : {}),
      }),
    }),
  // ق-201: a guest chooses a password and becomes an account, orders included.
  setPassword: (slug: string, password: string) =>
    storefrontRequest<{ account: Customer }>(path(slug, "account", "password"), {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  // ق-162: which governorates this store actually delivers to, and for how
  // much. Public: a shopper decides WHERE before he decides who he is.
  deliveryAreas: (slug: string) =>
    storefrontRequest<{ areas: DeliveryArea[] }>(path(slug, "delivery-areas")),
  product: (slug: string, productId: string) =>
    storefrontRequest<{ product: ProductDetail }>(path(slug, "products", productId)),
  /**
   * ق-238 — أيّ مقاسٍ تريد. بلا وسيطٍ تحصل على «card» (٨٠٠ بكسل) وهو ما تريده
   * الشبكة؛ فرابط الكتالوج يبقى كما كان حرفياً، ولا ينقسم مفتاح التخزين.
   * `thumb` للصور الصغيرة (سطر السلّة، شريط المصغّرات) و`full` للصورة الكبيرة.
   */
  imageUrl: (
    slug: string,
    productId: string,
    imageId: string,
    variant?: "thumb" | "card" | "full"
  ) => `${path(slug, "products", productId, "images", imageId)}${variant ? `?v=${variant}` : ""}`,
  // CD-2 — reading is public, writing needs a session scoped to this store.
  productReviews: (slug: string, productId: string) =>
    storefrontRequest<{
      summary: {
        average: number | null;
        count: number;
        hiddenCount: number;
        distribution: Record<string, number>;
      };
      reviews: {
        id: string;
        rating: number;
        body: string | null;
        hidden: boolean;
        author: string;
        createdAt: string;
        verifiedBuyer: boolean;
        mine: boolean;
      }[];
      nextCursor: string | null;
    }>(path(slug, "products", productId, "reviews")),
  // ق-175: shipped with the review routes and had no caller — a shopper could
  // write a review and never take it back.
  deleteReview: (slug: string, reviewId: string) =>
    storefrontRequest<void>(path(slug, "reviews", reviewId), { method: "DELETE" }),
  // CD-4 — public. `minOrdersTogether` travels with the list so the screen can
  // state the rule rather than leaving a shopper to wonder why it is empty.
  // CD-5 — his own points. `balanceValueIqd` travels too: «300 نقطة» means
  // nothing to a shopper until it is «3000 دينار».
  //
  // LOY-1 — and `lots` travels with it, oldest first, because that figure is no
  // longer `balance × pointValueIqd`. Each lot keeps the rate it was earned at,
  // so pricing a redemption means walking the queue rather than multiplying; the
  // screen does the same walk the server does and therefore shows him the money
  // he will actually get, not an estimate of it.
  // 20-2: `entries` is a keyset PAGE, so `cursor` travels here exactly as it
  // does on `orders`. The balance, the rate and the lots are computed over the
  // whole ledger and are the same on every page — only the log is paged.
  loyalty: (slug: string, cursor?: string | null) =>
    storefrontRequest<{
      enabled: boolean;
      pointValueIqd: number;
      earnPer1000: number;
      balance: number;
      balanceValueIqd: number;
      lots: { points: number; pointValueIqd: number; earnedAt: string }[];
      entries: {
        id: string;
        kind: string;
        points: number;
        signedPoints: number;
        valueIqd: number | null;
        pointValueIqd: number | null;
        createdAt: string;
        order: { id: string; orderNumber: string };
      }[];
      nextCursor: string | null;
    }>(
      `${path(slug, "account", "loyalty")}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  recommendations: (slug: string, productId: string) =>
    storefrontRequest<{
      minOrdersTogether: number;
      recommendations: {
        productId: string;
        name: string;
        priceIqd: number;
        ordersTogether: number;
        imageId: string | null;
      }[];
    }>(path(slug, "products", productId, "recommendations")),
  writeReview: (slug: string, productId: string, body: { rating: number; body?: string }) =>
    storefrontRequest<{ review: { id: string } }>(
      path(slug, "products", productId, "reviews", "mine"),
      { method: "PUT", body: JSON.stringify(body) }
    ),
  wishlist: (slug: string, cursor?: string | null) =>
    storefrontRequest<{
      items: {
        id: string;
        productId: string;
        productName: string;
        variantId: string;
        variantName: string | null;
        sku: string;
        priceIqd: number;
        inStock: boolean;
        notifyOnRestock: boolean;
      }[];
      nextCursor: string | null;
    }>(
      `${path(slug, "account", "wishlist")}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  addToWishlist: (slug: string, body: { variantId: string; notifyOnRestock?: boolean }) =>
    storefrontRequest<{ item: { id: string } }>(path(slug, "account", "wishlist"), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // CD-3 — the returns portal. Asking is not returning: these only create and
  // read requests; the merchant's approval is what moves the order.
  returns: (slug: string, cursor?: string | null) =>
    storefrontRequest<{
      requests: {
        id: string;
        status: "requested" | "approved" | "rejected" | "withdrawn";
        reason: string;
        decisionNote: string | null;
        decidedAt: string | null;
        reversalDeadline: string;
        createdAt: string;
        order: { id: string; orderNumber: string; totalIqd: number };
      }[];
      nextCursor: string | null;
    }>(
      `${path(slug, "account", "returns")}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  requestReturn: (slug: string, orderId: string, body: { reason: string }) =>
    storefrontRequest<{ request: { id: string; status: string } }>(
      path(slug, "account", "orders", orderId, "returns"),
      { method: "POST", body: JSON.stringify(body) }
    ),
  withdrawReturn: (slug: string, requestId: string) =>
    storefrontRequest<{ request: { id: string; status: string } }>(
      path(slug, "account", "returns", requestId, "withdraw"),
      { method: "POST" }
    ),
  removeFromWishlist: (slug: string, variantId: string) =>
    storefrontRequest<null>(path(slug, "account", "wishlist", variantId), { method: "DELETE" }),
  cart: (slug: string) => storefrontRequest<{ cart: Cart }>(path(slug, "cart")),
  // Phase 20A: a multi-variant add carries the chosen variantId; default-only
  // products keep the exact legacy request shape (productId resolves the
  // implicit default variant server-side).
  addCartItem: (slug: string, productId: string, quantity: number, variantId?: string) =>
    storefrontRequest<{ cart: Cart }>(path(slug, "cart", "items"), {
      method: "POST",
      body: JSON.stringify(
        variantId ? { productId, variantId, quantity } : { productId, quantity }
      ),
    }),
  updateCartItem: (slug: string, itemId: string, quantity: number) =>
    storefrontRequest<{ cart: Cart }>(path(slug, "cart", "items", itemId), {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    }),
  removeCartItem: (slug: string, itemId: string) =>
    storefrontRequest<void>(path(slug, "cart", "items", itemId), { method: "DELETE" }),
  register: (
    slug: string,
    values: { fullName: string; phone: string; password: string; email?: string }
  ) =>
    storefrontRequest<{ account: Customer; cart: Cart }>(path(slug, "account", "register"), {
      method: "POST",
      body: JSON.stringify(values),
    }),
  login: (slug: string, phone: string, password: string) =>
    storefrontRequest<{ account?: Customer; customer?: Customer; cart: Cart }>(
      path(slug, "account", "login"),
      { method: "POST", body: JSON.stringify({ phone, password }) }
    ),
  logout: (slug: string) =>
    storefrontRequest<void>(path(slug, "account", "logout"), { method: "POST" }),
  account: (slug: string) => storefrontRequest<{ customer: Customer }>(path(slug, "account")),
  addresses: (slug: string) =>
    storefrontRequest<{ addresses: Address[] }>(path(slug, "account", "addresses")),
  preferences: (slug: string) =>
    storefrontRequest<{ preferences: CustomerPreferences }>(path(slug, "account", "preferences")),
  deliveryQuote: (slug: string, addressId: string) =>
    storefrontRequest<{ delivery: DeliveryQuote }>(
      path(slug, "account", "addresses", addressId, "delivery-quote")
    ),
  addAddress: (
    slug: string,
    address: Omit<Address, "id" | "createdAt" | "phoneContactNormalized"> & { phoneContact: string }
  ) =>
    storefrontRequest<{ address: Address }>(path(slug, "account", "addresses"), {
      method: "POST",
      body: JSON.stringify(address),
    }),
  // ق-173: PATCH and DELETE shipped with the address routes and had no caller —
  // a saved address could be added and never corrected or removed.
  updateAddress: (
    slug: string,
    addressId: string,
    address: Omit<Address, "id" | "createdAt" | "phoneContactNormalized"> & { phoneContact: string }
  ) =>
    storefrontRequest<{ address: Address }>(path(slug, "account", "addresses", addressId), {
      method: "PATCH",
      body: JSON.stringify(address),
    }),
  deleteAddress: (slug: string, addressId: string) =>
    storefrontRequest<void>(path(slug, "account", "addresses", addressId), { method: "DELETE" }),
  // Phase 20B-1: couponCode is OPTIONAL and simply absent from the payload when
  // empty — the server fingerprint stays identical to the pre-coupon shape.
  // PG-5: `note` travels the same way `couponCode` does — present only when the
  // customer wrote one, so a payload without a note is byte-identical to what
  // this client sent before the field existed.
  checkout: (
    slug: string,
    body: {
      cartVersion: number;
      addressId: string;
      paymentMethodCode: string;
      idempotencyKey: string;
      couponCode?: string;
      note?: string;
      loyaltyPoints?: number;
    }
  ) =>
    storefrontRequest<{ order: CustomerOrder; replayed: boolean }>(path(slug, "checkout"), {
      method: "POST",
      headers: { "Idempotency-Key": body.idempotencyKey },
      body: JSON.stringify({
        cartVersion: body.cartVersion,
        addressId: body.addressId,
        paymentMethodCode: body.paymentMethodCode,
        idempotencyKey: body.idempotencyKey,
        ...(body.couponCode ? { couponCode: body.couponCode } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.loyaltyPoints ? { loyaltyPoints: body.loyaltyPoints } : {}),
      }),
    }),
  couponPreview: (slug: string, couponCode: string) =>
    storefrontRequest<{ preview: CouponPreview }>(path(slug, "cart", "coupon-preview"), {
      method: "POST",
      body: JSON.stringify({ couponCode }),
    }),
  uploadPrescription: (slug: string, orderId: string, file: File) => {
    const form = new FormData();
    form.append("prescription", file);
    return storefrontRequest<{
      prescription: { id: string; contentType: string; byteSize: number };
      prescriptionStatus: PrescriptionStatus;
    }>(path(slug, "account", "orders", orderId, "prescription"), { method: "POST", body: form });
  },
  prescriptionUrl: (slug: string, orderId: string) =>
    path(slug, "account", "orders", orderId, "prescription"),
  orders: (slug: string, cursor?: string | null) =>
    storefrontRequest<{ orders: OrderListItem[]; nextCursor: string | null }>(
      `${path(slug, "account", "orders")}?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  order: (slug: string, orderId: string) =>
    storefrontRequest<{ order: CustomerOrder }>(path(slug, "account", "orders", orderId)),
  history: (slug: string, orderId: string) =>
    storefrontRequest<{ events: TimelineEvent[] }>(
      path(slug, "account", "orders", orderId, "history")
    ),
  // Phase 20B-3: public marketing config — the pixels key is absent unless the
  // merchant enabled the integration and every id passed strict validation.
  // MD-1: `vacation` is present only while the store is in vacation mode.
  // ق-199: …and now everything the merchant owns about his shop's face, so the
  // shell and the home page make ONE request between them.
  publicConfig: (slug: string) => storefrontRequest<StorefrontConfig>(path(slug, "public-config")),
  // CD-1a: public «أين طلبي؟» lookup — no session, no cookie needed.
  trackOrder: (slug: string, orderNumber: string, phone: string) =>
    storefrontRequest<{ order: TrackedOrder }>(path(slug, "orders", "track"), {
      method: "POST",
      body: JSON.stringify({ orderNumber, phone }),
    }),
  // CD-1c: one-click reorder from the customer's own order history.
  reorder: (slug: string, orderId: string) =>
    storefrontRequest<{ cart: Cart; skipped: ReorderSkip[]; addedCount: number }>(
      path(slug, "account", "orders", orderId, "reorder"),
      { method: "POST" }
    ),
  // PG-1: the customer calls off their own order while the store has not started it.
  cancelOrder: (slug: string, orderId: string, reason?: string) =>
    storefrontRequest<{ order: { id: string; status: string; version: number } }>(
      path(slug, "account", "orders", orderId, "cancel"),
      { method: "POST", body: JSON.stringify(reason ? { reason } : {}) }
    ),
};

/** CD-1c: honest, human Arabic for each skip reason. */
export const reorderSkipReasonLabel: Record<ReorderSkipReason, string> = {
  product_unavailable: "لم يعد متاحًا في المتجر",
  insufficient_stock: "الكمية المطلوبة غير متوفرة حاليًا",
  quantity_limit: "تجاوزت الكمية الحدّ المسموح (للسلّة أو للطلب الواحد)",
};

/**
 * CD-1c: one honest sentence naming every line that did not make it. A default
 * variant carries the product's own name, so it is not repeated in parentheses
 * — the same display rule the low-stock notification uses.
 */
export function reorderSkippedNotice(skipped: ReorderSkip[]) {
  if (!skipped.length) return "";
  const lines = skipped.map(
    (item) =>
      `${item.productName}${item.variantName && item.variantName !== item.productName ? ` (${item.variantName})` : ""} — ${reorderSkipReasonLabel[item.reason]}`
  );
  return `تعذّرت إضافة ${skipped.length} من منتجات الطلب: ${lines.join("، ")}.`;
}

/**
 * ق-221 — the lines a checkout refusal named, or none. A refusal that says
 * «منتج أو أكثر» to a shopper with ten lines is an instruction to fix something
 * without saying what; the server now names each one, and this is where a
 * screen reads them.
 */
export function refusedLines(error: unknown): RefusedCartLine[] {
  if (!(error instanceof StorefrontApiError)) return [];
  const lines = error.details.lines;
  return Array.isArray(lines)
    ? (lines as RefusedCartLine[]).filter(
        (line) => line && typeof line === "object" && typeof line.requested === "number"
      )
    : [];
}

export function errorMessage(error: unknown) {
  if (!(error instanceof StorefrontApiError)) return "حدث خطأ غير متوقع. حاول مجددًا.";
  const messages: Partial<Record<ApiErrorCode, string>> = {
    CUSTOMER_SESSION_REQUIRED: "سجّل الدخول للمتابعة إلى هذه الصفحة.",
    INVALID_CUSTOMER_CREDENTIALS: "بيانات الدخول غير صحيحة.",
    INVALID_CART_QUANTITY: "الكمية المطلوبة غير صالحة.",
    CART_EMPTY: "لا يمكن إتمام طلب من سلة فارغة.",
    INVALID_ADDRESS: "تحقق من بيانات العنوان ثم حاول مجددًا.",
    PAYMENT_METHOD_NOT_SUPPORTED: "طريقة الدفع المتاحة حاليًا هي الدفع عند الاستلام فقط.",
    IDEMPOTENCY_KEY_REUSED:
      "تعذر إكمال المحاولة الحالية. تم تحديث البيانات، راجع السلة ثم حاول مجددًا.",
    CART_VERSION_CONFLICT: "تم تحديث السلة. أعدنا تحميل أحدث بياناتها.",
    CART_ALREADY_CHECKED_OUT: "تم تحويل هذه السلة إلى طلب سابقًا.",
    CART_PRICE_CHANGED: "تغيّرت أسعار بعض منتجات سلتك. حدّثنا الأسعار — راجع الملخص ثم أكّد الطلب.",
    PRODUCT_UNAVAILABLE: "أحد المنتجات لم يعد متاحًا. عدّل السلة ثم حاول مجددًا.",
    INSUFFICIENT_AVAILABLE_STOCK: "الكمية المطلوبة لم تعد متاحة بالكامل.",
    DELIVERY_UNAVAILABLE_FOR_GOVERNORATE:
      "التوصيل غير متاح حاليًا للمحافظة المختارة. اختر عنوانًا في محافظة متاحة.",
    RATE_LIMITED: "كثرت المحاولات. انتظر قليلًا ثم حاول مجددًا.",
    RESOURCE_NOT_FOUND: "العنصر المطلوب غير موجود أو غير متاح.",
    INVALID_COUPON_CODE: "صيغة رمز الكوبون غير صالحة.",
    COUPON_INVALID: "الكوبون غير صالح لهذا المتجر أو تم إيقافه.",
    COUPON_EXPIRED: "الكوبون خارج فترة صلاحيته.",
    COUPON_MIN_SUBTOTAL_NOT_MET: "قيمة السلة أقل من الحد الأدنى المطلوب لهذا الكوبون.",
    COUPON_EXHAUSTED: "انتهت مرات استخدام هذا الكوبون.",
    COUPON_CUSTOMER_LIMIT_REACHED: "استخدمت هذا الكوبون بالحد الأقصى المسموح لحسابك.",
    PRESCRIPTION_NOT_REQUIRED: "هذا الطلب لا يتطلب وصفة طبية.",
    PRESCRIPTION_ALREADY_SUBMITTED: "الوصفة مرفوعة بالفعل وهي قيد المراجعة أو معتمدة.",
    INVALID_PRESCRIPTION_IMAGE:
      "ملف الوصفة يجب أن يكون صورة JPEG أو PNG أو WebP بحجم لا يتجاوز 5 MB.",
    PRESCRIPTION_NOT_APPROVED: "لا يمكن معالجة الطلب قبل اعتماد الوصفة الطبية.",
    INVALID_TRACKING_REQUEST: "أدخل رقم الطلب ورقم الهاتف المستخدم عند الطلب.",
    ORDER_NOT_CANCELLABLE:
      "بدأ المتجر بتجهيز طلبك، فلم يعد إلغاؤه ممكنًا من هنا — تواصل مع المتجر مباشرة.",
    INVALID_CANCELLATION_REASON: "سبب الإلغاء طويل جدًا — اختصره في 500 حرف.",
    STORE_ON_VACATION:
      "المتجر في إجازة مؤقتة ولا يستقبل طلبات جديدة حالياً — يمكنك التصفّح وإتمام الطلب بعد عودته.",
    STORE_IN_MAINTENANCE: "المتجر مغلق للصيانة — نعود قريباً.",
    CAPABILITY_UNAVAILABLE: "هذه الخدمة غير متاحة حالياً.",
    GUEST_CHECKOUT_DISABLED: "هذا المتجر يطلب تسجيل الدخول لإتمام الطلب.",
    STORE_NOT_ACCEPTING_ORDERS: "المتجر لا يستقبل طلبات جديدة حالياً — تواصل مع المتجر.",
    CUSTOMER_ACCOUNT_EXISTS: "هذا الرقم مسجّل لدينا — سجّل الدخول لإتمام الطلب.",
    EMAIL_TAKEN: "هذا البريد مستخدم لحساب آخر في هذا المتجر — اتركه فارغاً أو سجّل الدخول.",
    INVALID_FULL_NAME: "اكتب اسمك الكامل.",
    INVALID_PHONE: "اكتب رقم هاتفك بصيغة 07XXXXXXXXX.",
    ACCOUNT_HAS_PASSWORD: "هذا الحساب يملك كلمة مرور بالفعل.",
  };
  return messages[error.code] ?? (error.message || "تعذر إتمام الطلب.");
}

export type DeliveryArea = { key: string; name: string; amountIqd: number };

export { formatIqd } from "./price-label";
