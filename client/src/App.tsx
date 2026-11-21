/** Design reminder — codiq phase 2 uses a calm One UI dashboard shell; this file only defines navigation routes. */
import { lazy, Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import { DemoBanner, useDemoMode } from "./components/DemoBanner";
import { useLocation } from "wouter";

/**
 * ق-137: «اريد الصفحة التعريفية تفتح بسرعة لا تتأخر بالتحميل». Only Home —
 * the page the world links to — stays in the entry chunk. Every other surface
 * (three dashboards, the till, the storefront cluster, the logins, demo entry)
 * loads on navigation. The landing must never pay for the dashboards, and the
 * split is guarded by perf-budget.guard.mjs so it cannot silently regress.
 *
 * Two rules keep the browser suites honest:
 * - Home is EAGER, so «/» never suspends and the fallback never flashes there.
 * - The fallback is null (not a spinner): a lazy chunk on a local or same-region
 *   connection resolves faster than a spinner can stop looking like jank.
 */
const MerchantDashboard = lazy(() => import("./pages/MerchantDashboard"));
const OwnerDashboard = lazy(() => import("./pages/OwnerDashboard"));
const StaffDashboard = lazy(() => import("./pages/StaffDashboard"));
const PlatformStaffDashboard = lazy(() => import("./pages/PlatformStaffDashboard"));
const TillPage = lazy(() => import("./pages/TillPage"));
const DashboardLogin = lazy(() => import("./pages/DashboardLogin"));
const DemoEntryPage = lazy(() => import("./pages/DemoEntryPage"));
const UnsubscribePage = lazy(() => import("./pages/UnsubscribePage"));
/* PR-1: lazy like every other non-landing surface — ق-137's budget is measured
   on the entry chunk, and account recovery must not be paid for by the
   marketing page every visitor loads. */
const PasswordResetRequest = lazy(() => import("./pages/PasswordResetRequest"));
const PasswordResetConsume = lazy(() => import("./pages/PasswordResetConsume"));
const EngineeringArchitectureDashboard = lazy(
  () => import("./pages/EngineeringArchitectureDashboard")
);
const StorefrontWrapper = lazy(() => import("./pages/StorefrontWrapper"));
/* Marketplace (docs/MARKETPLACE_PLAN.md): the shopper app, its own chunk. */
const MarketApp = lazy(() => import("./market/MarketApp"));

/**
 * Phase 17: a store subdomain or custom domain lands directly in its storefront.
 * The server resolves Host → store; app hosts (localhost, *.up.railway.app) skip
 * the lookup. `?codiq_host=` forces a host for browser-test coverage.
 */
function useHostStorefrontRedirect() {
  const [location, navigate] = useLocation();
  useEffect(() => {
    if (location !== "/") return;
    const forced = new URLSearchParams(window.location.search).get("codiq_host");
    const hostname = forced ?? window.location.hostname;
    if (
      !forced &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".up.railway.app"))
    )
      return;
    fetch(`/api/public/store-for-host?host=${encodeURIComponent(hostname)}`)
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (body?.slug) navigate(`/store/${encodeURIComponent(body.slug)}`, { replace: true });
      })
      .catch(() => undefined);
  }, [location, navigate]);
}

/**
 * P27-7: the owner surface is 404'd by the server in the demo environment
 * (demoBlockedSurfaceGuard). This mirrors that in the SPA so a prospect who types
 * /platform/login does not even meet an owner login form — the demo must not
 * advertise that an owner area exists. It is a complement to the server rule, never
 * the rule itself: every request behind these screens is refused server-side anyway.
 */
function HiddenInDemo({ children }: { children: React.ReactNode }) {
  const demo = useDemoMode();
  if (demo === null) return null; // unknown yet: show nothing rather than flash the owner screen
  return demo ? <NotFound /> : <>{children}</>;
}

/**
 * `index.html` now carries the PUBLIC marketing title, because `/` is the page
 * the world links to and nothing was updating `document.title` at all. The
 * dashboards are a different product surface, so this keeps their tab honest —
 * the marketing title stays the default for `/`, the storefront, and anything
 * unlisted (a storefront's own title belongs to the store, not to CODIQ).
 */
const ROUTE_TITLES: [RegExp, string][] = [
  [/^\/platform(\/|$)/, "Codiq — لوحة مالك المنصة"],
  [/^\/merchant(\/|$)/, "Codiq — لوحة التاجر"],
  [/^\/staff(\/|$)/, "Codiq — لوحة الموظف"],
  [/^\/engineering(\/|$)/, "Codiq — لوحة الهندسة"],
  [/^\/market(\/|$)/, "Codiq ماركت — كل المتاجر في مكان واحد"],
];
const DEFAULT_TITLE = "Codiq — منصة المتاجر الإلكترونية بالدفع عند الاستلام في العراق";

function useDocumentTitle() {
  const [location] = useLocation();
  useEffect(() => {
    document.title = ROUTE_TITLES.find(([pattern]) => pattern.test(location))?.[1] ?? DEFAULT_TITLE;
  }, [location]);
}

function Router() {
  useHostStorefrontRedirect();
  useDocumentTitle();
  return (
    <>
      {/* P27-7: the demo banner is mounted ONCE, above the route table, so EVERY
        route carries it — including the ones that have no shell of their own:
        `/` (the public marketing page a prospect reaches by trimming the demo
        link), the three login pages, `/demo`, and NotFound. It used to be
        mounted inside the merchant, staff and storefront shells only, which
        left the marketing page — the page with the self-registration form on
        it — looking exactly like production. Renders null outside the demo
        environment, so this is a no-op in staging and production. */}
      <DemoBanner />
      <Suspense fallback={null}>
        <Switch>
          <Route path={"/"} component={Home} />
          {/* PG-3: reached from a link in an email — no session, and never inside a store shell. */}
          <Route path={"/unsubscribe/:token"} component={UnsubscribePage} />
          {/* PR-1 «استعادة كلمة السر». Four mount points, two components.
          The reset pages are session-less by nature — a person who cannot sign
          in must not meet a screen that assumes he did — so they sit outside
          every shell, exactly like /unsubscribe above.
          The storefront pair is NOT routed through StorefrontWrapper for the
          same reason, and the slug in its path is what binds a shopper's
          request to the store he actually has an account at: `customers` is
          UNIQUE(store_id, email), so the same address is a different person at
          a different shop. */}
          <Route path={"/forgot-password"} component={PasswordResetRequest} />
          <Route path={"/reset-password"} component={PasswordResetConsume} />
          <Route
            path={"/store/:storeSlug/account/forgot-password"}
            component={PasswordResetRequest}
          />
          <Route
            path={"/store/:storeSlug/account/reset-password"}
            component={PasswordResetConsume}
          />
          <Route path={"/engineering/architecture"} component={EngineeringArchitectureDashboard} />
          {/* P27-7: the guest-entry link the owner sends to prospects. Inert outside
          the demo environment — the server never registers /api/public/demo-login there. */}
          <Route path={"/demo"} component={DemoEntryPage} />
          <Route path={"/platform/login"}>
            {() => (
              <HiddenInDemo>
                <DashboardLogin kind="platform" />
              </HiddenInDemo>
            )}
          </Route>
          {/* المرحلة 19-ب: the platform-staff door hides in the demo exactly like the
          owner's — the demo must not advertise that a platform area exists. */}
          <Route path={"/platform/staff/login"}>
            {() => (
              <HiddenInDemo>
                <DashboardLogin kind="platformStaff" />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/platform/staff/dashboard/:section/:subsection"}>
            {() => (
              <HiddenInDemo>
                <PlatformStaffDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/platform/staff/dashboard/:section"}>
            {() => (
              <HiddenInDemo>
                <PlatformStaffDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/platform/staff/dashboard"}>
            {() => (
              <HiddenInDemo>
                <PlatformStaffDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/merchant/login"}>{() => <DashboardLogin kind="merchant" />}</Route>
          <Route path={"/staff/login"}>{() => <DashboardLogin kind="staff" />}</Route>
          {/* ق-132: the till is a FULL-SCREEN counter surface, deliberately outside
          the dashboard shell — a cashier with a queue does not navigate. */}
          <Route path={"/merchant/stores/:storeSlug/till"} component={TillPage} />
          <Route
            path={"/staff/stores/:storeSlug/dashboard/:section/:subsection"}
            component={StaffDashboard}
          />
          <Route path={"/staff/stores/:storeSlug/dashboard/:section"} component={StaffDashboard} />
          <Route path={"/staff/stores/:storeSlug/dashboard"} component={StaffDashboard} />
          <Route
            path={"/merchant/stores/:storeSlug/dashboard/:section/:subsection/:detail"}
            component={MerchantDashboard}
          />
          <Route
            path={"/merchant/stores/:storeSlug/dashboard/:section/:subsection"}
            component={MerchantDashboard}
          />
          <Route
            path={"/merchant/stores/:storeSlug/dashboard/:section"}
            component={MerchantDashboard}
          />
          <Route path={"/merchant/stores/:storeSlug/dashboard"} component={MerchantDashboard} />
          <Route
            path={"/merchant/dashboard/:section/:subsection/:detail"}
            component={MerchantDashboard}
          />
          <Route path={"/merchant/dashboard/:section/:subsection"} component={MerchantDashboard} />
          <Route path={"/merchant/dashboard/:section"} component={MerchantDashboard} />
          <Route path={"/merchant/dashboard"} component={MerchantDashboard} />
          <Route path={"/store/:storeSlug/account/orders/:orderId"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/orders"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/wishlist"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/returns"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/addresses"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/preferences"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/register"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/account/login"} component={StorefrontWrapper} />
          {/* ق-203: the catalog grid moved off the front page; categories and the written policies have pages of their own. */}
          <Route path={"/store/:storeSlug/products"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/categories/:categoryId"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/policies/:kind"} component={StorefrontWrapper} />
          {/* ق-211: the pages the merchant wrote himself, linked from «روابط مهمة». */}
          <Route path={"/store/:storeSlug/pages/:pageSlug"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/products/:productId"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/cart"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/checkout"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug/track"} component={StorefrontWrapper} />
          <Route path={"/store/:storeSlug"} component={StorefrontWrapper} />
          <Route path={"/platform/dashboard/:section/:subsection/:detail"}>
            {() => (
              <HiddenInDemo>
                <OwnerDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/platform/dashboard/:section/:subsection"}>
            {() => (
              <HiddenInDemo>
                <OwnerDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/platform/dashboard/:section"}>
            {() => (
              <HiddenInDemo>
                <OwnerDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/platform/dashboard"}>
            {() => (
              <HiddenInDemo>
                <OwnerDashboard />
              </HiddenInDemo>
            )}
          </Route>
          <Route path={"/market"} nest component={MarketApp} />
          <Route path={"/404"} component={NotFound} />
          {/* Final fallback route */}
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
