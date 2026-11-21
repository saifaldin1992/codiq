import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Cart,
  Customer,
  errorMessage,
  StorefrontCategory,
  StorefrontConfig,
  storefrontApi,
} from "@/lib/storefront-api";
import { initStorefrontPixels, trackPageView } from "@/lib/storefront-pixels";

type StorefrontContextValue = {
  slug: string;
  cart: Cart | null;
  customer: Customer | null;
  loading: boolean;
  notice: string | null;
  /** ق-199: the shop's face — name, logo, announcement, contact, policies, payment methods, home sections. `null` until it arrives. */
  config: StorefrontConfig | null;
  /** The nested category tree, shared by the header drawer, the catalog filter and the breadcrumb. */
  categories: StorefrontCategory[];
  refreshCart: () => Promise<Cart>;
  refreshAccount: () => Promise<Customer | null>;
  refreshAll: () => Promise<void>;
  setNotice: (notice: string | null) => void;
  setCart: (cart: Cart) => void;
  setCustomer: (customer: Customer | null) => void;
};
const StorefrontContext = createContext<StorefrontContextValue | null>(null);

/** The product id when the route is a product page — the beacon counts a view then. */
function productIdOf(location: string): string | undefined {
  const match = location.match(/\/products\/([^/?#]+)$/);
  return match?.[1];
}

export function StorefrontProvider({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [config, setConfig] = useState<StorefrontConfig | null>(null);
  const [categories, setCategories] = useState<StorefrontCategory[]>([]);
  const [location] = useLocation();
  const refreshCart = useCallback(async () => {
    const data = await storefrontApi.cart(slug);
    setCart(data.cart);
    return data.cart;
  }, [slug]);
  const refreshAccount = useCallback(async () => {
    try {
      const data = await storefrontApi.account(slug);
      setCustomer(data.customer);
      return data.customer;
    } catch {
      setCustomer(null);
      return null;
    }
  }, [slug]);
  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([refreshCart(), refreshAccount()]);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [refreshCart, refreshAccount]);
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);
  // ق-199: ONE fetch of the shop's face per mount, exposed through the context —
  // the shell and the home page used to fetch it separately.
  //
  // Phase 20B-3 (D-26): the ad pixels are injected HERE and nowhere else —
  // dashboards never mount StorefrontProvider, so this is the structural
  // guarantee that no dashboard page ever loads a marketing script. Events
  // fired before the config resolves are queued inside the pixels module.
  useEffect(() => {
    let cancelled = false;
    storefrontApi
      .publicConfig(slug)
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        initStorefrontPixels(loaded.pixels ?? {});
      })
      .catch(() => {
        if (!cancelled) initStorefrontPixels({});
      });
    storefrontApi
      .categories(slug)
      .then((data) => {
        if (!cancelled) setCategories(data.categories);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);
  // PageView on every storefront route change (the mount itself included) —
  // and, ق-202, the store's own visit beacon, with the product when it is one.
  useEffect(() => {
    trackPageView();
    void storefrontApi.visit(slug, productIdOf(location));
  }, [slug, location]);
  const value = useMemo(
    () => ({
      slug,
      cart,
      customer,
      loading,
      notice,
      config,
      categories,
      refreshCart,
      refreshAccount,
      refreshAll,
      setNotice,
      setCart,
      setCustomer,
    }),
    [
      slug,
      cart,
      customer,
      loading,
      notice,
      config,
      categories,
      refreshCart,
      refreshAccount,
      refreshAll,
    ]
  );
  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>;
}
export function useStorefront() {
  const context = useContext(StorefrontContext);
  if (!context) throw new Error("StorefrontProvider is required.");
  return context;
}
