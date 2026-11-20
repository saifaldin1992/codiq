import { Link } from "wouter";
import { ShoppingBag, Sparkles, Store, Truck, Wallet } from "lucide-react";

/** M0: the welcome card and the four promises. The sections (banners, deals, lists) arrive in M3. */
export function MarketHomePage() {
  const promises = [
    { icon: ShoppingBag, text: "كل المتاجر في مكان واحد" },
    { icon: Sparkles, text: "عروض جديدة كل يوم" },
    { icon: Truck, text: "توصيل لباب بيتك" },
    { icon: Wallet, text: "ادفع نقداً عند الاستلام" },
  ];
  return (
    <div className="space-y-5" data-testid="market-home">
      <section className="rounded-[28px] bg-[var(--codiq-accent)] p-6 text-[var(--codiq-surface)] shadow-sm">
        <p className="text-xs font-bold opacity-80">أهلاً بك في السوق</p>
        <h1 className="mt-2 text-2xl font-black leading-tight">تسوّق من كل متاجر العراق بسلّة وحدة</h1>
        <Link href="/stores" className="mt-5 inline-flex items-center gap-2 rounded-full bg-[var(--codiq-surface)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-accent)]" data-testid="market-home-browse-stores">
          <Store className="h-4 w-4" /> تصفّح المتاجر
        </Link>
      </section>
      <ul className="grid grid-cols-2 gap-3">
        {promises.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] p-3 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm">
            <Icon className="h-5 w-5 shrink-0 text-[var(--codiq-accent)]" /> {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
