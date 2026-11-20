/**
 * M0 pages whose content arrives in later phases. Each says what will be here
 * and offers a way onward — a tab never opens onto a dead end.
 */
import { Link, useSearch } from "wouter";
import { Grid2x2, Search, ShoppingBag, UserRound } from "lucide-react";
import { MarketEmptyState } from "../MarketEmptyState";

const browseStores = (
  <Link href="/stores" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">تصفّح المتاجر</Link>
);

export function MarketCategoriesPage() {
  return <MarketEmptyState testId="market-categories" icon={Grid2x2} title="الفئات" body="تصفّح المنتجات حسب القسم الذي يناسبك." action={browseStores} />;
}

export function MarketCartPage() {
  return <MarketEmptyState testId="market-cart" icon={ShoppingBag} title="سلتك فارغة" body="ابدأ التسوّق واكتشف عروض اليوم." action={browseStores} />;
}

export function MarketAccountPage() {
  return <MarketEmptyState testId="market-account" icon={UserRound} title="حسابي" body="سجّل الدخول برقم هاتفك لمتابعة طلباتك وعناوينك ومفضّلتك." action={browseStores} />;
}

export function MarketSearchPage() {
  const query = new URLSearchParams(useSearch()).get("q") ?? "";
  return <MarketEmptyState testId="market-search" icon={Search} title={query ? `نتائج «${query}»` : "البحث"} body="البحث في كل متاجر السوق." action={browseStores} />;
}

export function MarketNotFoundPage() {
  return <MarketEmptyState testId="market-not-found" icon={Search} title="الصفحة غير موجودة" body="ربما تغيّر الرابط أو حُذفت الصفحة." action={<Link href="/" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">عودة للرئيسية</Link>} />;
}
