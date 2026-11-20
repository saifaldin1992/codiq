/**
 * The customer-facing storefront cluster, split out of App.tsx so the «/»
 * landing chunk does not carry it. Everything a shopper needs — shell,
 * provider, and the storefront pages — enters the bundle only when a
 * /store/:slug route actually mounts (ق-137: the landing must open fast).
 *
 * ق-203: the bare `/store/:slug` is now the HOME page; the catalog grid moved
 * to `/products` (and answers `/categories/:id`), and the written policies
 * have pages. Every branch here has a <Route> in App.tsx — the
 * storefront-routes guard holds the two lists equal.
 */
import { useLocation, useParams } from "wouter";
import CustomerReturnsPage from "@/pages/CustomerReturnsPage";
import CustomerAddressesPage from "@/pages/CustomerAddressesPage";
import CustomerPreferencesPage from "@/pages/CustomerPreferencesPage";
import CustomerWishlistPage from "@/pages/CustomerWishlistPage";
import { StorefrontProvider } from "../components/StorefrontProvider";
import { StorefrontShell } from "../components/StorefrontShell";
import StorefrontHomePage from "./StorefrontHomePage";
import StorefrontCatalogPage from "./StorefrontCatalogPage";
import StorefrontProductPage from "./StorefrontProductPage";
import StorefrontPolicyPage from "./StorefrontPolicyPage";
import StorefrontCartPage from "./StorefrontCartPage";
import CustomerAuthPage from "./CustomerAuthPage";
import StorefrontCheckoutPage from "./StorefrontCheckoutPage";
import CustomerOrdersPage from "./CustomerOrdersPage";
import CustomerOrderDetailPage from "./CustomerOrderDetailPage";
import StorefrontTrackOrderPage from "./StorefrontTrackOrderPage";

export default function StorefrontWrapper() {
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const [location] = useLocation();
  let page = <StorefrontHomePage />;
  if (/\/products$/.test(location)) page = <StorefrontCatalogPage />;
  else if (/\/categories\/[^/]+$/.test(location)) page = <StorefrontCatalogPage />;
  else if (/\/policies\/[^/]+$/.test(location)) page = <StorefrontPolicyPage />;
  // ق-211: the merchant's own footer pages, drawn by the same component.
  else if (/\/pages\/[^/]+$/.test(location)) page = <StorefrontPolicyPage />;
  else if (/\/products\/[^/]+$/.test(location)) page = <StorefrontProductPage />;
  else if (/\/cart$/.test(location)) page = <StorefrontCartPage />;
  else if (/\/account\/(login|register)$/.test(location)) page = <CustomerAuthPage />;
  else if (/\/checkout$/.test(location)) page = <StorefrontCheckoutPage />;
  else if (/\/account\/orders\/[^/]+$/.test(location)) page = <CustomerOrderDetailPage />;
  else if (/\/account\/orders$/.test(location)) page = <CustomerOrdersPage />;
  else if (/\/account\/wishlist$/.test(location)) page = <CustomerWishlistPage />;
  else if (/\/account\/returns$/.test(location)) page = <CustomerReturnsPage />;
  else if (/\/account\/addresses$/.test(location)) page = <CustomerAddressesPage />;
  else if (/\/account\/preferences$/.test(location)) page = <CustomerPreferencesPage />;
  // CD-1a: the public «أين طلبي؟» page — inside the storefront shell, but it
  // needs no customer session of any kind.
  else if (/\/track$/.test(location)) page = <StorefrontTrackOrderPage />;
  return <StorefrontProvider slug={storeSlug}><StorefrontShell>{page}</StorefrontShell></StorefrontProvider>;
}
