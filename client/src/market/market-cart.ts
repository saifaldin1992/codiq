/** The shopper's market cart, shared by the tab badge, the product page and the cart page. */
import { useEffect, useState } from "react";
import { accountCall, useShopper } from "./market-shopper";

export type CartLine = {
  id: string;
  product: {
    id: string;
    name: string;
    imageUrl: string | null;
    isPreorder: boolean;
    maxPerOrder: number | null;
  };
  variant: { id: string; name: string | null };
  addons: { id: string; name: string; priceIqd: number }[];
  quantity: number;
  unitPriceIqd: number;
  livePriceIqd: number;
  /** Marketplace M8a: the list price while «عرض الساعة» lowers it. */
  listPriceIqd: number | null;
  lineTotalIqd: number;
  available: number | null;
  problem:
    | null
    | "unavailable"
    | "addon_unavailable"
    | "out_of_stock"
    | "insufficient_stock"
    | "price_changed";
};
export type CartStore = {
  store: { slug: string; name: string; logoUrl: string | null; pickupEnabled: boolean };
  lines: CartLine[];
  subtotalIqd: number;
  ready: boolean;
};
export type MarketCart = { version: number; count: number; stores: CartStore[] };

let cart: MarketCart | null = null;
const listeners = new Set<(next: MarketCart | null) => void>();
function publish(next: MarketCart | null) {
  cart = next;
  listeners.forEach((listener) => listener(cart));
}

export async function refreshCart() {
  try {
    publish(await accountCall<MarketCart>("/api/market/cart"));
  } catch {
    publish(null);
  }
}

/** Every cart write answers with the whole cart; publishing it keeps every screen in step. */
export async function cartWrite(url: string, init: RequestInit) {
  const next = await accountCall<MarketCart>(url, init);
  publish(next);
  return next;
}

export function useMarketCart() {
  const { shopper } = useShopper();
  const [current, setCurrent] = useState<MarketCart | null>(cart);
  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  useEffect(() => {
    if (shopper) void refreshCart();
    else publish(null);
  }, [shopper?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return current;
}

export const PROBLEM_TEXT: Record<NonNullable<CartLine["problem"]>, string> = {
  unavailable: "لم يعد هذا المنتج متاحاً — احذفه من السلة",
  addon_unavailable: "إحدى الإضافات لم تعد متاحة — احذف المنتج وأضفه من جديد",
  out_of_stock: "نفد هذا الخيار",
  insufficient_stock: "الكمية المطلوبة أكبر من المتوفّر",
  price_changed: "تغيّر السعر منذ أضفته",
};
