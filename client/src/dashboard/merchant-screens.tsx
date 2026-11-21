/**
 * THE MERCHANT DASHBOARD'S SCREENS — path → screen, in one table.
 *
 * This replaces a single nested ternary (31 paths, one 6,500-character line) in
 * MerchantDashboard.tsx. To add a screen: add its entry here and its menu item in
 * `config/navigation.ts`. Nothing in MerchantDashboard.tsx changes.
 *
 * Generated from the previous ternary branch by branch, so every path renders
 * exactly what it rendered before. A path listed twice («A || B») maps both keys
 * to the same screen.
 */
import type { ReactNode } from "react";
import { AbandonedCartsPanel } from "@/components/AbandonedCartsPanel";
import { AccountSecurityPanel } from "@/components/AccountSecurityPanel";
import { CouponsManager } from "@/components/CouponsManager";
import { CustomersDirectory } from "@/components/CustomersDirectory";
import { DeliveryCenter } from "@/components/DeliveryCenter";
import { DeliveryRatesManager } from "@/components/DeliveryRatesManager";
import { LoyaltySettingsCard } from "@/components/LoyaltySettingsCard";
import { MarketProfilePanel } from "@/components/MarketProfilePanel";
import { MarketCatalogPanel } from "@/components/MarketCatalogPanel";
import { SupportTicketsWorkspace } from "@/components/SupportTicketsWorkspace";
import { MarketDealsPanel } from "@/components/MarketDealsPanel";
import { MarketReelsPanel } from "@/components/MarketReelsPanel";
import { ManualCustomerForm } from "@/components/ManualCustomerForm";
import { MarketingIntegrationsPanel } from "@/components/MarketingIntegrationsPanel";
import { MerchantAnalytics } from "@/components/MerchantAnalytics";
import { MerchantConfigPanel } from "@/components/MerchantConfigPanel";
import { MerchantFinancePanel } from "@/components/MerchantFinancePanel";
import { MerchantMonthlyReport } from "@/components/MerchantMonthlyReport";
import { MerchantPaymentsPanel } from "@/components/MerchantPaymentsPanel";
import { MerchantServicesPanel } from "@/components/MerchantServicesPanel";
import { NotificationCenter } from "@/components/NotificationCenter";
import { PosDevicesPanel } from "@/components/PosDevicesPanel";
import { ReturnsQueue } from "@/components/ReturnsQueue";
import { ReviewModeration } from "@/components/ReviewModeration";
import { StockForecastPanel } from "@/components/StockForecastPanel";
import { StoreTeamManager } from "@/components/StoreTeamManager";
import { StorefrontSettingsPanel } from "@/components/StorefrontSettingsPanel";
import { StoresManager } from "@/components/StoresManager";
import { SubscriptionPanel } from "@/components/SubscriptionPanel";
import { TrashBin } from "@/components/TrashBin";

export type MerchantScreenContext = {
  storeSlug: string | undefined;
  navigate: (path: string) => void;
};
export type MerchantScreen = (context: MerchantScreenContext) => ReactNode;

export const MERCHANT_SCREENS: Readonly<Record<string, MerchantScreen>> = {
  "/merchant/dashboard/settings/storefront": ({ storeSlug }) => (
    <StorefrontSettingsPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/stores": ({ storeSlug, navigate }) => (
    <StoresManager mode="list" storeSlug={storeSlug} navigate={navigate} />
  ),
  "/merchant/dashboard/stores/create": ({ storeSlug, navigate }) => (
    <StoresManager mode="create" storeSlug={storeSlug} navigate={navigate} />
  ),
  "/merchant/dashboard/settings/config": ({ storeSlug }) => (
    <MerchantConfigPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/services": ({ storeSlug }) => (
    <MerchantServicesPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/stores/manage": ({ storeSlug, navigate }) => (
    <StoresManager mode="manage" storeSlug={storeSlug} navigate={navigate} />
  ),
  "/merchant/dashboard/settings/store": ({ storeSlug, navigate }) => (
    <StoresManager mode="manage" storeSlug={storeSlug} navigate={navigate} />
  ),
  "/merchant/dashboard/stores/team": ({ storeSlug }) => <StoreTeamManager storeSlug={storeSlug} />,
  "/merchant/dashboard/customers": ({ storeSlug }) => <CustomersDirectory storeSlug={storeSlug} />,
  "/merchant/dashboard/customers/abandoned-carts": ({ storeSlug }) => (
    <AbandonedCartsPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/orders/reports": ({ storeSlug }) => (
    <MerchantAnalytics storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/marketing/reports": ({ storeSlug }) => (
    <MerchantAnalytics storeSlug={storeSlug} showCoupons />
  ),
  "/merchant/dashboard/products/forecast": ({ storeSlug }) => (
    <StockForecastPanel storeSlug={storeSlug ?? ""} />
  ),
  "/merchant/dashboard/marketing/monthly": ({ storeSlug }) => (
    <MerchantMonthlyReport storeSlug={storeSlug ?? ""} />
  ),
  "/merchant/dashboard/orders/returns": ({ storeSlug }) => (
    <ReturnsQueue storeSlug={storeSlug ?? ""} />
  ),
  "/merchant/dashboard/orders/support-tickets": ({ storeSlug }) => (
    <SupportTicketsWorkspace kind="store" storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/products/reviews": ({ storeSlug }) => (
    <ReviewModeration storeSlug={storeSlug ?? ""} />
  ),
  "/merchant/dashboard/marketing/coupons": ({ storeSlug }) => (
    <CouponsManager storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/payments": ({ storeSlug }) => (
    <MerchantPaymentsPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/integrations": ({ storeSlug }) => (
    <MarketingIntegrationsPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/notifications": ({ storeSlug }) => (
    <NotificationCenter storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/account/notifications": ({ storeSlug }) => (
    <NotificationCenter storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/shipping": ({ storeSlug }) => (
    <DeliveryRatesManager storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/orders/delivery": ({ storeSlug }) => (
    <DeliveryCenter storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/loyalty": ({ storeSlug }) => (
    <LoyaltySettingsCard storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/market": ({ storeSlug }) => (
    <MarketProfilePanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/products/market": ({ storeSlug }) => (
    <MarketCatalogPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/products/market-deals": ({ storeSlug }) => (
    <MarketDealsPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/products/market-reels": ({ storeSlug }) => (
    <MarketReelsPanel storeSlug={storeSlug} />
  ),
  "/merchant/dashboard/settings/pos": ({ storeSlug }) => <PosDevicesPanel storeSlug={storeSlug} />,
  "/merchant/dashboard/settings/trash": ({ storeSlug }) => <TrashBin storeSlug={storeSlug} />,
  "/merchant/dashboard/settings/subscription": () => <SubscriptionPanel />,
  "/merchant/dashboard/orders/settlements": () => <MerchantFinancePanel />,
  "/merchant/dashboard/account/security": () => <AccountSecurityPanel view="password" />,
  "/merchant/dashboard/account/sessions-devices": () => <AccountSecurityPanel view="sessions" />,
  "/merchant/dashboard/customers/add": ({ storeSlug }) => (
    <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        إضافة يدوية مقيدة بالمتجر
      </p>
      <h2 className="mb-5 text-xl font-bold text-[var(--codiq-text)]">
        إضافة عميل إلى المتجر الحالي
      </h2>
      <ManualCustomerForm storeSlug={storeSlug} />
    </div>
  ),
};

/** The screen for a canonical dashboard path, or null when the path has no screen of its own. */
export function merchantScreenFor(path: string, context: MerchantScreenContext): ReactNode | null {
  const screen = MERCHANT_SCREENS[path];
  return screen ? screen(context) : null;
}
