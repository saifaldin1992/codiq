/** The market's own «page not found» — inside the market frame, with a way back. */
import { Link } from "wouter";
import { Search } from "lucide-react";
import { MarketEmptyState } from "../MarketEmptyState";

export function MarketNotFoundPage() {
  return <MarketEmptyState testId="market-not-found" icon={Search} title="الصفحة غير موجودة" body="ربما تغيّر الرابط أو حُذفت الصفحة." action={<Link href="/" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">عودة للرئيسية</Link>} />;
}
