/**
 * codiq phase 14 — the single navigation source for every dashboard shell.
 * Owner, merchant, and staff sidebars are all built from these definitions;
 * no dashboard keeps a local hardcoded nav tree. Staff entries carry the
 * permission that gates them, but filtering here is presentation only —
 * the server-side resolver stays the sole authorization authority.
 *
 * Menus pass A (owner-approved «قوائم أقل، صفحات أذكى», 2026-08-26):
 * status sub-menus collapsed into in-page filter chips, duplicate entries
 * merged, and EVERY entry now carries an honest `status` — either
 * "implemented" or `{ phase }` rendered as a «قريباً — المرحلة X» badge (B-13).
 */
import {
  Boxes,
  CircleUserRound,
  ClipboardList,
  CreditCard,
  Layers3,
  Megaphone,
  MonitorSmartphone,
  PackageSearch,
  ScrollText,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Mirrors the staff pattern: implemented now, or scheduled for a named phase. */
export type NavEntryStatus = "implemented" | { phase: string };
/** ق-251: `capability` names what the entry needs; the sidebar shows the platform's state beside it (قريباً / تحت الصيانة …). */
export type NavEntry = { label: string; path: string; context?: string; status: NavEntryStatus; capability?: string };
export type NavGroup = { id: string; label: string; icon: LucideIcon; entries: NavEntry[] };

/** Mirrors PERMISSION_CODES in phase1-backend/src/auth/staff-permissions.ts (the server source of truth). */
export type StorePermissionCode =
  | "catalog.products.view"
  | "catalog.products.create"
  | "catalog.products.update"
  | "catalog.products.delete"
  | "catalog.categories.manage"
  | "inventory.update"
  | "orders.view"
  | "orders.update"
  | "customers.view"
  | "customers.manage"
  // PG-2. `catalog.trash.restore` additionally requires the permission that
  // governs the entity being restored (`team.manage` for a team seat,
  // `settings.manage` for a coupon) — see TRASH_GOVERNING_PERMISSION.
  | "catalog.trash.view"
  | "catalog.trash.restore"
  | "catalog.audit.view"
  | "pos.sell"
  | "team.manage"
  | "settings.manage";

/** Mirrors PERMISSION_CODES in phase1-backend/src/auth/platform-permissions.ts (the server source of truth). */
export type PlatformPermissionCode =
  | "overview.view"
  | "registrations.approve"
  | "merchants.manage"
  | "plans.manage"
  | "finance.view"
  | "finance.settle"
  | "orders.oversee"
  | "brand.manage"
  | "audit.view"
  // ق-249 (المرحلة 29)
  | "services.manage"
  | "availability.manage";

export const ownerDashboardPath = "/platform/dashboard";
export const ownerPrimaryEntry: NavEntry = { label: "الرئيسية", path: ownerDashboardPath, status: "implemented" };

export const ownerNavGroups: NavGroup[] = [
  {
    id: "merchants",
    label: "التجار والمتاجر",
    icon: Store,
    entries: [
      // «إدارة التجار» merged into «التجار»، و«التحقق» merged into «طلبات التسجيل» (pass A).
      { label: "التجار", path: "/platform/dashboard/merchants", status: "implemented" },
      { label: "إضافة تاجر", path: "/platform/dashboard/merchants/add", status: "implemented" },
      { label: "طلبات التسجيل", path: "/platform/dashboard/merchants/registration-requests", status: "implemented" },
      { label: "المتاجر", path: "/platform/dashboard/stores", status: "implemented" },
      // Marketplace M1: who is in the shared market, who is waiting, and the marks only the platform grants.
      { label: "السوق", path: "/platform/dashboard/market", status: "implemented" },
      { label: "إضافة متجر", path: "/platform/dashboard/stores/add", status: { phase: "الدفعة B" } },
    ],
  },
  {
    id: "orders",
    label: "الطلبات",
    icon: ShoppingBag,
    entries: [
      // Status sub-menus live as filter chips inside the orders page now (pass A).
      { label: "جميع الطلبات", path: "/platform/dashboard/orders", status: "implemented" },
      { label: "بحاجة لإجراء", path: "/platform/dashboard/orders/action-needed", status: "implemented" },
      { label: "الإرجاع", path: "/platform/dashboard/orders/returns", status: "implemented" },
      { label: "التسليم", path: "/platform/dashboard/orders/delivery", status: { phase: "25أ" } },
      // 20B delivered MERCHANT analytics; platform-wide order reports move
      // with the operations batch.
      { label: "التقارير", path: "/platform/dashboard/orders/reports", status: { phase: "24" } },
    ],
  },
  {
    id: "finance",
    label: "الاشتراكات والمالية",
    icon: CreditCard,
    entries: [
      { label: "الاشتراكات", path: "/platform/dashboard/subscriptions", status: "implemented" },
      { label: "الخطط", path: "/platform/dashboard/plans", status: "implemented" },
      { label: "طلبات الترقية", path: "/platform/dashboard/upgrade-requests", status: "implemented" },
      { label: "الفواتير", path: "/platform/dashboard/invoices", status: { phase: "25أ" } },
      { label: "المدفوعات", path: "/platform/dashboard/payments", status: { phase: "25أ" } },
      { label: "العمولات", path: "/platform/dashboard/commissions", status: "implemented" },
      { label: "التسويات", path: "/platform/dashboard/settlements", status: "implemented" },
      { label: "التقارير المالية", path: "/platform/dashboard/financial-reports", status: "implemented" },
    ],
  },
  {
    id: "platform",
    label: "المنصة",
    icon: Layers3,
    entries: [
      // The six site-builder entries collapsed into one honest placeholder (pass A);
      // 20B closed without it — the site builder rides the phase-21+ content work.
      { label: "الموقع التعريفي", path: "/platform/dashboard/site", status: { phase: "21+" } },
      { label: "إعدادات المنصة", path: "/platform/dashboard/platform-settings", status: "implemented" },
      // ق-249 (المرحلة 29): what the platform offers, whether it is on, and for whom.
      { label: "الخدمات والإتاحة", path: "/platform/dashboard/services", status: "implemented" },
      // The platform's modules and the domain events each one listens to (modules/registry.ts).
      { label: "الوحدات", path: "/platform/dashboard/modules", status: "implemented" },
      { label: "طاقم المنصة", path: "/platform/dashboard/platform-staff", status: "implemented" },
      { label: "النطاقات والروابط", path: "/platform/dashboard/domains-links", status: { phase: "24" } },
      { label: "التكاملات", path: "/platform/dashboard/integrations", status: { phase: "24" } },
      // Phase 20 (20A+20B) closed without a public developers API — it rides
      // the integrations batch.
      { label: "المطورون", path: "/platform/dashboard/developers", status: { phase: "24" } },
      { label: "النظام والصيانة", path: "/platform/dashboard/system-maintenance", status: { phase: "24" } },
    ],
  },
  {
    // PC-1 (owner request, 2026-09-04): one area, one name. «حسابي» held only the
    // owner's own identity; «معلومات التواصل» — the platform's published email and
    // phone — is the other half of what he opens this group to change, and he asked
    // for both to be here. Naming the group after both is what makes the second one
    // findable: a man looking for his phone number does not open «حسابي».
    id: "account",
    label: "حسابي ومعلومات التواصل",
    icon: UserRound,
    entries: [
      { label: "الملف الشخصي", path: "/platform/dashboard/account/profile", status: { phase: "19" } },
      // «الأمان» now carries the email change beside the password change.
      { label: "الأمان", path: "/platform/dashboard/account/security", status: "implemented" },
      { label: "معلومات التواصل", path: "/platform/dashboard/account/contact", status: "implemented" },
      { label: "الجلسات والأجهزة", path: "/platform/dashboard/account/sessions-devices", status: "implemented" },
      { label: "الإشعارات", path: "/platform/dashboard/account/notifications", status: { phase: "19" } },
      { label: "اللغة", path: "/platform/dashboard/account/language", status: { phase: "22" } },
      { label: "تسجيل الخروج", path: "/platform/dashboard/account/sign-out", status: "implemented" },
    ],
  },
];

export const merchantDashboardPath = "/merchant/dashboard";
export const merchantPrimaryEntry: NavEntry = { label: "الرئيسية", path: merchantDashboardPath, status: "implemented" };

/**
 * MERCHANT — ordered by how often a shop owner opens it, not by how the system
 * is built. Orders first because that is what he checks at nine at night;
 * settings last because he touches them twice a year.
 *
 * Rebuilt after studying اكد, IQ Soft and ويل (2026-08-31). What changed, and why:
 *
 *   - THE SCHEDULED DESTINATIONS LEFT THE SIDEBAR. Fifteen of forty-eight
 *     entries led to a «قريباً» placeholder — one in three. A merchant looking
 *     for his orders was reading a roadmap. They now live in ONE place,
 *     `merchantRoadmap`, behind one entry at the bottom. Nothing is hidden and
 *     nothing is claimed: the honesty B-13 asked for is kept, it is simply not
 *     repeated fifteen times in the way of someone trying to work.
 *   - FOUR DUPLICATE DESTINATIONS ARE GONE. `/orders/returns` appeared twice
 *     under two labels; «التقارير» appeared in two groups; «الإشعارات» appeared
 *     in two groups; and `/stores/manage` and `/settings/store` render the same
 *     screen. A menu offering two doors to one room teaches people it cannot be
 *     trusted, and then they stop reading it.
 *   - MONEY GOT ITS OWN GROUP. Settlements sat under Orders, the subscription
 *     under Settings, the monthly report under Marketing. «كم دخل وكم لي؟» is
 *     one question and now has one place.
 *   - «المتاجر» FOLDED INTO SETTINGS. The header already carries a store
 *     switcher, so a whole top-level group was paying for the multi-store case
 *     on every screen of every merchant who has one store.
 *
 * EVERY PATH IS UNCHANGED. Only grouping, order and visibility moved — so deep
 * links, bookmarks and the browser suites keep working exactly as they did.
 */
export const merchantNavGroups: NavGroup[] = [
  {
    id: "orders",
    label: "الطلبات",
    icon: ClipboardList,
    entries: [
      // His inbox, and therefore first: the only screen that answers «ما الذي
      // ينتظرني الآن؟». It used to be second.
      { label: "بحاجة لإجراء", path: "/merchant/dashboard/orders/action-needed", status: "implemented" },
      { label: "جميع الطلبات", path: "/merchant/dashboard/orders", status: "implemented" },
      { label: "الإرجاع", path: "/merchant/dashboard/orders/returns", status: "implemented", capability: "cx.returns" },
    ],
  },
  {
    id: "products",
    label: "المنتجات",
    icon: PackageSearch,
    entries: [
      { label: "جميع المنتجات", path: "/merchant/dashboard/products", status: "implemented" },
      { label: "إضافة منتج", path: "/merchant/dashboard/products/add", status: "implemented" },
      { label: "التصنيفات", path: "/merchant/dashboard/products/categories", status: "implemented" },
      { label: "المخزون", path: "/merchant/dashboard/products/inventory", status: "implemented" },
      // Kept beside stock rather than filed under reports: it answers a stock
      // question, and it is the one thing none of the three rivals has.
      { label: "متى ينفد مخزونك", path: "/merchant/dashboard/products/forecast", status: "implemented" },
      { label: "المراجعات", path: "/merchant/dashboard/products/reviews", status: "implemented", capability: "cx.reviews" },
      { label: "استيراد/تصدير CSV", path: "/merchant/dashboard/products/import-export", status: "implemented", capability: "data.csv" },
    ],
  },
  {
    id: "customers",
    label: "العملاء",
    icon: UsersRound,
    entries: [
      { label: "جميع العملاء", path: "/merchant/dashboard/customers", status: "implemented" },
      { label: "إضافة عميل", path: "/merchant/dashboard/customers/add", status: "implemented" },
      { label: "السلات المتروكة", path: "/merchant/dashboard/customers/abandoned-carts", status: "implemented", capability: "marketing.abandoned_carts" },
    ],
  },
  {
    id: "finance",
    label: "المالية",
    icon: CreditCard,
    entries: [
      // ONE reports home. There were two «التقارير» in two different groups, and
      // a merchant had to guess which of them held his numbers.
      { label: "التقارير", path: "/merchant/dashboard/orders/reports", status: "implemented", capability: "data.analytics" },
      { label: "التسويات", path: "/merchant/dashboard/orders/settlements", status: "implemented" },
      { label: "شهرك في Codiq", path: "/merchant/dashboard/marketing/monthly", status: "implemented", capability: "data.monthly_report" },
      { label: "الاشتراك", path: "/merchant/dashboard/settings/subscription", status: "implemented" },
    ],
  },
  {
    id: "marketing",
    label: "التسويق",
    icon: Megaphone,
    entries: [
      { label: "الكوبونات", path: "/merchant/dashboard/marketing/coupons", status: "implemented", capability: "offers.coupons" },
      // Named for what it actually is. As a second «التقارير» it competed with
      // the real one in المالية for the same word.
      { label: "أداء الكوبونات", path: "/merchant/dashboard/marketing/reports", status: "implemented", capability: "data.analytics" },
    ],
  },
  {
    id: "settings",
    label: "الإعدادات",
    icon: Settings2,
    entries: [
      // ق-199/ق-204: the shop's FACE first — name, logo, slides, announcement,
      // contact, policies, home sections, guest checkout — one screen, the
      // reference dashboard's «الإعدادات ← التخطيط». Everything a shopper sees
      // that differs from shop to shop is edited here and nowhere else.
      { label: "واجهة المتجر", path: "/merchant/dashboard/settings/storefront", status: "implemented" },
      { label: "إعدادات المتجر", path: "/merchant/dashboard/settings/store", status: "implemented" },
      // Marketplace M1: the store in the shared market — listing request, place, hours, cover, reputation.
      { label: "السوق", path: "/merchant/dashboard/settings/market", status: "implemented" },
      // ق-249 (المرحلة 29): what works in this store right now, and why not when not.
      { label: "الخدمات", path: "/merchant/dashboard/settings/services", status: "implemented" },
      // ق-251: the configuration hierarchy as the merchant reads it, and his own level of it.
      { label: "التهيئة", path: "/merchant/dashboard/settings/config", status: "implemented" },
      // ق-209: real switches now — cash, wallet transfers, and the gateways
      // that wait for 25أ, named as such.
      { label: "الدفع", path: "/merchant/dashboard/settings/payments", status: "implemented" },
      { label: "التوصيل", path: "/merchant/dashboard/settings/shipping", status: "implemented", capability: "delivery.rates" },
      { label: "الإشعارات", path: "/merchant/dashboard/settings/notifications", status: "implemented" },
      // ق-166: CD-5 shipped everything but this entry, so `loyaltyEnabled`
      // could never leave false and the shopper's redeem card was dead in
      // every store.
      { label: "برنامج النقاط", path: "/merchant/dashboard/settings/loyalty", status: "implemented", capability: "offers.loyalty" },
      { label: "التكاملات", path: "/merchant/dashboard/settings/integrations", status: "implemented", capability: "marketing.pixels" },
      { label: "الكاشير", path: "/merchant/dashboard/settings/pos", status: "implemented", capability: "pos.devices" },
      { label: "فريق المتجر", path: "/merchant/dashboard/stores/team", status: "implemented", capability: "team.staff" },
      { label: "سلة المحذوفات", path: "/merchant/dashboard/settings/trash", status: "implemented" },
    ],
  },
  {
    // ق-204: back out of «الإعدادات» into a group of its own — more than one
    // store per merchant is a first-order promise of the platform, not a
    // rarer act to bury under the switch for notifications.
    id: "stores",
    label: "المتاجر",
    icon: Store,
    entries: [
      { label: "جميع المتاجر", path: "/merchant/dashboard/stores", status: "implemented" },
      { label: "إنشاء متجر", path: "/merchant/dashboard/stores/create", status: "implemented" },
    ],
  },
  {
    id: "account",
    label: "حسابي",
    icon: CircleUserRound,
    entries: [
      { label: "الأمان", path: "/merchant/dashboard/account/security", status: "implemented" },
      { label: "الجلسات والأجهزة", path: "/merchant/dashboard/account/sessions-devices", status: "implemented" },
    ],
  },
];

/**
 * Everything scheduled but not built, for the merchant.
 *
 * OUT of the sidebar and INTO one page. These are the same entries that used to
 * sit inline wearing a «قريباً» badge. Keeping them here preserves the honest
 * roadmap while giving fifteen dead ends back to the person trying to run his
 * shop. The dashboards still index these paths, so a bookmark to one keeps
 * showing its correct «قادمة ضمن المرحلة X» screen rather than falling through
 * to a generic page.
 */
export const merchantRoadmap: NavEntry[] = [
  // ق-246: the manual precursor of 25أ — handovers, the courier manifest and
  // the COD cash reconciliation. 25أ replaces the data source, not the screen.
  { label: "التسليم", path: "/merchant/dashboard/orders/delivery", status: "implemented", capability: "delivery.handover" },
  { label: "العروض", path: "/merchant/dashboard/marketing/offers", status: { phase: "25ب" } },
  { label: "الحملات", path: "/merchant/dashboard/marketing/campaigns", status: { phase: "25ب" } },
  { label: "التواصل", path: "/merchant/dashboard/marketing/communication", status: { phase: "25ب" } },
  { label: "القالب", path: "/merchant/dashboard/storefront/theme", status: { phase: "21" } },
  { label: "الصفحات", path: "/merchant/dashboard/storefront/pages", status: { phase: "21" } },
  { label: "محرر الصفحات", path: "/merchant/dashboard/storefront/page-editor", status: { phase: "21" } },
  { label: "القوائم والتنقل", path: "/merchant/dashboard/storefront/navigation", status: { phase: "21" } },
  { label: "الوسائط", path: "/merchant/dashboard/storefront/media", status: { phase: "21+" } },
  { label: "SEO", path: "/merchant/dashboard/storefront/seo", status: { phase: "22" } },
  { label: "النشر والإصدارات", path: "/merchant/dashboard/storefront/publishing-versions", status: { phase: "21+" } },
  { label: "الملف الشخصي", path: "/merchant/dashboard/account/profile", status: { phase: "19" } },
  { label: "اللغة", path: "/merchant/dashboard/account/language", status: { phase: "22" } },
];

/** The one sidebar entry that leads to everything above. */
export const merchantRoadmapEntry: NavEntry = { label: "قريباً", path: "/merchant/dashboard/roadmap", status: "implemented" };

/** «قريباً — المرحلة X» text for a scheduled entry; null when implemented. */
export function comingSoonLabel(status: NavEntryStatus): string | null {
  return status === "implemented" ? null : `قريباً — المرحلة ${status.phase}`;
}

export type StaffNavEntry = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Appended to /staff/stores/:storeSlug/dashboard — empty string is the home entry. */
  segment: string;
  /** Server permission required to show the entry; null means always visible. */
  permission: StorePermissionCode | null;
  status: "implemented" | "placeholder";
  /**
   * ق-132: the till lives OUTSIDE the staff dashboard shell
   * (/merchant/stores/:slug/till — a full-screen counter surface), so the one
   * entry that points there carries its own path builder instead of a segment.
   */
  path?: (storeSlug: string) => string;
};

export const staffNavEntries: StaffNavEntry[] = [
  { id: "home", label: "الرئيسية", icon: CircleUserRound, segment: "", permission: null, status: "implemented" },
  { id: "orders", label: "الطلبات", icon: ClipboardList, segment: "orders", permission: "orders.view", status: "implemented" },
  { id: "till", label: "الكاشير", icon: Store, segment: "", permission: "pos.sell", status: "implemented", path: (storeSlug) => `/merchant/stores/${encodeURIComponent(storeSlug)}/till` },
  { id: "products", label: "المنتجات", icon: PackageSearch, segment: "products", permission: "catalog.products.view", status: "implemented" },
  { id: "inventory", label: "المخزون", icon: Boxes, segment: "inventory", permission: "inventory.update", status: "implemented" },
  { id: "customers", label: "العملاء", icon: UsersRound, segment: "customers", permission: "customers.view", status: "implemented" },
  // ق-178 (D-84): `store_manager` held catalog.trash.view and catalog.audit.view
  // from the day the codes existed, and had no entry behind either — the
  // merchant reached both, the manager he delegated to could not.
  { id: "trash", label: "سلة المحذوفات", icon: Trash2, segment: "trash", permission: "catalog.trash.view", status: "implemented" },
  { id: "activity", label: "سجل النشاط", icon: ScrollText, segment: "activity", permission: "catalog.audit.view", status: "implemented" },
  { id: "team", label: "فريق المتجر", icon: UsersRound, segment: "team", permission: "team.manage", status: "implemented" },
  { id: "settings", label: "الإشعارات والإعدادات", icon: Settings2, segment: "settings", permission: "settings.manage", status: "implemented" },
  // Audit 14-ب: the employee's own password and sessions. Every other shell had
  // «الأمان»; the staff shell did not, so the password the merchant typed could
  // never be replaced from inside the dashboard.
  { id: "security", label: "الأمان", icon: ShieldCheck, segment: "security", permission: null, status: "implemented" },
  { id: "sessions", label: "الجلسات والأجهزة", icon: MonitorSmartphone, segment: "sessions", permission: null, status: "implemented" },
];

export function staffDashboardBase(storeSlug: string): string {
  return `/staff/stores/${encodeURIComponent(storeSlug)}/dashboard`;
}

export function staffEntryPath(storeSlug: string, entry: StaffNavEntry): string {
  if (entry.path) return entry.path(storeSlug);
  return entry.segment ? `${staffDashboardBase(storeSlug)}/${entry.segment}` : staffDashboardBase(storeSlug);
}

/** Presentation-only filter: the server already refuses unauthorized requests with 403. */
export function visibleStaffEntries(permissions: readonly string[]): StaffNavEntry[] {
  return staffNavEntries.filter((entry) => entry.permission === null || permissions.includes(entry.permission));
}

// المرحلة 19-ب: the platform-staff nav DATA lives in ./platform-staff-navigation,
// not here. Home.tsx imports this module eagerly, so every runtime byte added
// here ships in the landing's entry chunk — exactly what ق-137 forbids. Only the
// type above (erased at build) and the one owner nav entry belong in this file.
