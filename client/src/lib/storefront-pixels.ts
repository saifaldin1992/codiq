/**
 * codiq phase 20B-3 — ad pixels (D-26), storefront-only injection.
 *
 * STRUCTURAL GUARANTEE: this module is imported (and initialized) EXCLUSIVELY
 * by StorefrontProvider. Dashboards (owner/merchant/staff) never mount that
 * provider, so no dashboard page can ever load a third-party marketing script.
 *
 * The ids arrive from GET /store/:slug/public-config, which only returns them
 * when the merchant enabled the integration AND each id passed the strict
 * server-side format validation. The same patterns are re-checked here before
 * anything touches the DOM — defense in depth, never the primary defense.
 *
 * Events (client-side, best-effort):
 * - PageView on every storefront route change;
 * - AddToCart after a SUCCESSFUL addCartItem (value = chosen variant price);
 * - Purchase on checkout success ONLY when the response was not an idempotent
 *   replay (!replayed) — a replayed checkout must never double-count.
 *
 * Future CSP note (D-34): when helmet lands, allow the three script origins on
 * STOREFRONT pages only — connect.facebook.net, analytics.tiktok.com,
 * www.googletagmanager.com. Dashboard pages get no third-party script origin.
 * The policy must ALSO include worker-src 'self' (and a script-src 'self' that
 * covers /sw.js) or shipped POS-offline dies silently — the till's service
 * worker simply fails to register, with no error surfaced anywhere.
 * Conversions API (server-side events) is explicitly deferred to phases 24/25.
 */

export type StorefrontPixelIds = {
  metaPixelId?: string;
  tiktokPixelId?: string;
  ga4MeasurementId?: string;
};

const META_PIXEL_ID_PATTERN = /^[0-9]{5,20}$/;
const TIKTOK_PIXEL_ID_PATTERN = /^[A-Z0-9]{10,30}$/;
const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

type PixelWindow = Window & {
  fbq?: ((...args: unknown[]) => void) & {
    callMethod?: (...args: unknown[]) => void;
    queue: unknown[];
    push: unknown;
    loaded: boolean;
    version: string;
  };
  _fbq?: unknown;
  ttq?: any;
  TiktokAnalyticsObject?: string;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
};

let initialized = false;
let active: { meta?: string; tiktok?: string; ga4?: string } = {};
/** Events fired before the async public-config fetch resolves wait here. */
const pendingEvents: Array<() => void> = [];

function loadScript(src: string) {
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

/** Official Meta base snippet, written as TS: stub fbq, then load fbevents.js. */
function injectMeta(pixelId: string, w: PixelWindow) {
  if (!w.fbq) {
    const stub: any = (...args: unknown[]) => {
      stub.callMethod ? stub.callMethod(...args) : stub.queue.push(args);
    };
    stub.queue = [];
    stub.push = stub;
    stub.loaded = true;
    stub.version = "2.0";
    w.fbq = stub;
    if (!w._fbq) w._fbq = stub;
    loadScript("https://connect.facebook.net/en_US/fbevents.js");
  }
  w.fbq!("init", pixelId);
}

/** Official TikTok snippet, written as TS: method stubs + ttq.load(id). */
function injectTikTok(pixelId: string, w: PixelWindow) {
  w.TiktokAnalyticsObject = "ttq";
  const ttq: any = (w.ttq = w.ttq ?? []);
  const methods = [
    "page",
    "track",
    "identify",
    "instances",
    "debug",
    "on",
    "off",
    "once",
    "ready",
    "alias",
    "group",
    "enableCookie",
    "disableCookie",
  ];
  const setAndDefer = (target: any, method: string) => {
    target[method] = (...args: unknown[]) => target.push([method, ...args]);
  };
  for (const method of methods) setAndDefer(ttq, method);
  ttq.instance = (name: string) => {
    const instance = ttq._i?.[name] ?? [];
    for (const method of methods) setAndDefer(instance, method);
    return instance;
  };
  ttq.load = (id: string) => {
    const src = "https://analytics.tiktok.com/i18n/pixel/events.js";
    ttq._i = ttq._i ?? {};
    ttq._i[id] = [];
    ttq._i[id]._u = src;
    ttq._t = ttq._t ?? {};
    ttq._t[id] = +new Date();
    ttq._o = ttq._o ?? {};
    loadScript(`${src}?sdkid=${id}&lib=ttq`);
  };
  ttq.load(pixelId);
}

/** Official gtag.js bootstrap; page_view is sent manually on route changes. */
function injectGa4(measurementId: string, w: PixelWindow) {
  w.dataLayer = w.dataLayer ?? [];
  if (!w.gtag) {
    w.gtag = function gtag() {
      // gtag REQUIRES the Arguments object itself (not a spread array).
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    };
  }
  loadScript(`https://www.googletagmanager.com/gtag/js?id=${measurementId}`);
  w.gtag("js", new Date());
  w.gtag("config", measurementId, { send_page_view: false });
}

/**
 * Called once by StorefrontProvider with the public-config pixels (or {} when
 * the store has none). Idempotent: a second call — e.g. navigating to another
 * store inside one SPA session — is ignored; a fresh document load re-inits.
 */
export function initStorefrontPixels(ids: StorefrontPixelIds) {
  if (initialized || typeof document === "undefined") return;
  initialized = true;
  const w = window as unknown as PixelWindow;
  const meta =
    ids.metaPixelId && META_PIXEL_ID_PATTERN.test(ids.metaPixelId) ? ids.metaPixelId : undefined;
  const tiktok =
    ids.tiktokPixelId && TIKTOK_PIXEL_ID_PATTERN.test(ids.tiktokPixelId)
      ? ids.tiktokPixelId
      : undefined;
  const ga4 =
    ids.ga4MeasurementId && GA4_MEASUREMENT_ID_PATTERN.test(ids.ga4MeasurementId)
      ? ids.ga4MeasurementId
      : undefined;
  if (meta) injectMeta(meta, w);
  if (tiktok) injectTikTok(tiktok, w);
  if (ga4) injectGa4(ga4, w);
  active = { meta, tiktok, ga4 };
  const queued = pendingEvents.splice(0, pendingEvents.length);
  for (const event of queued) event();
}

function dispatch(event: () => void) {
  if (!initialized) {
    pendingEvents.push(event);
    return;
  }
  if (!active.meta && !active.tiktok && !active.ga4) return; // pixel-less store: no-op
  try {
    event();
  } catch {
    /* analytics must never break the storefront */
  }
}

export function trackPageView() {
  dispatch(() => {
    const w = window as unknown as PixelWindow;
    if (active.meta && w.fbq) w.fbq("track", "PageView");
    if (active.tiktok && w.ttq?.page) w.ttq.page();
    if (active.ga4 && w.gtag)
      w.gtag("event", "page_view", {
        page_location: window.location.href,
        page_title: document.title,
      });
  });
}

export function trackAddToCart(valueIqd: number) {
  dispatch(() => {
    const w = window as unknown as PixelWindow;
    if (active.meta && w.fbq) w.fbq("track", "AddToCart", { value: valueIqd, currency: "IQD" });
    if (active.tiktok && w.ttq?.track)
      w.ttq.track("AddToCart", { value: valueIqd, currency: "IQD" });
    if (active.ga4 && w.gtag) w.gtag("event", "add_to_cart", { value: valueIqd, currency: "IQD" });
  });
}

export function trackPurchase(valueIqd: number, orderNumber: string) {
  dispatch(() => {
    const w = window as unknown as PixelWindow;
    if (active.meta && w.fbq) w.fbq("track", "Purchase", { value: valueIqd, currency: "IQD" });
    if (active.tiktok && w.ttq?.track)
      w.ttq.track("CompletePayment", { value: valueIqd, currency: "IQD" });
    if (active.ga4 && w.gtag)
      w.gtag("event", "purchase", {
        value: valueIqd,
        currency: "IQD",
        transaction_id: orderNumber,
      });
  });
}
