/**
 * codiq المرحلة 19-ب — the navigation source for the platform-staff shell.
 *
 * A SEPARATE module from ./navigation for one measured reason: Home.tsx imports
 * that module eagerly, so its runtime bytes ship in the landing's entry chunk
 * (ق-137 keeps that chunk frozen). This file is imported only by the lazy
 * platform-staff pages, so it rides their chunk and the entry stays unchanged.
 * The PlatformPermissionCode type stays in ./navigation beside its siblings —
 * types are erased and cost the entry nothing.
 */
import { Activity, Boxes, CircleUserRound, ClipboardList, CreditCard, Layers3, PackageSearch, Palette, Power, ScrollText, Settings2, ShoppingBag, Store, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PlatformPermissionCode } from "@/config/navigation";

export type PlatformStaffNavEntry = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Appended to /platform/staff/dashboard — empty string is the home entry. */
  segment: string;
  /** Server permission required to show the entry; null means always visible. */
  permission: PlatformPermissionCode | null;
  status: "implemented";
};

export const platformStaffDashboardBase = "/platform/staff/dashboard";

/**
 * One platform, no tenant boundary — so unlike staffNavEntries there is no slug
 * to thread and the base is a constant. Filtering stays presentation only;
 * requirePlatformActor refuses on the server either way.
 */
export const platformStaffNavEntries: PlatformStaffNavEntry[] = [
  { id: "home", label: "الرئيسية", icon: CircleUserRound, segment: "", permission: null, status: "implemented" },
  // ق-170: `overview.view` is granted to all three roles and had no screen —
  // the home page showed the permission as a chip and nothing behind it.
  { id: "overview", label: "نبض الأعمال", icon: Activity, segment: "overview", permission: "overview.view", status: "implemented" },
  { id: "registrations", label: "طلبات التسجيل", icon: ClipboardList, segment: "registrations", permission: "registrations.approve", status: "implemented" },
  { id: "merchants", label: "التجار", icon: Store, segment: "merchants", permission: "merchants.manage", status: "implemented" },
  { id: "stores", label: "المتاجر", icon: Boxes, segment: "stores", permission: "merchants.manage", status: "implemented" },
  { id: "orders", label: "الطلبات", icon: ShoppingBag, segment: "orders", permission: "orders.oversee", status: "implemented" },
  { id: "plans", label: "الخطط", icon: Layers3, segment: "plans", permission: "plans.manage", status: "implemented" },
  { id: "subscriptions", label: "الاشتراكات", icon: CreditCard, segment: "subscriptions", permission: "plans.manage", status: "implemented" },
  { id: "upgrade-requests", label: "طلبات الترقية", icon: PackageSearch, segment: "upgrade-requests", permission: "plans.manage", status: "implemented" },
  { id: "finance", label: "المالية", icon: CreditCard, segment: "finance", permission: "finance.view", status: "implemented" },
  // ق-170: both were grantable from the team screen — «إدارة هوية المنصة»,
  // «سجل التدقيق» — and the routes answered 200 to the supervisor. The links
  // simply did not exist, so a granted permission did nothing.
  { id: "brand", label: "هوية المنصة", icon: Palette, segment: "brand", permission: "brand.manage", status: "implemented" },
  { id: "audit", label: "سجل التدقيق", icon: ScrollText, segment: "audit", permission: "audit.view", status: "implemented" },
  // ق-249 (المرحلة 29): the control room. `availability.manage` is an act inside this
  // same screen (the overrides tab), exempted by name in platform-nav.guard.mjs.
  { id: "services", label: "الخدمات والإتاحة", icon: Power, segment: "services", permission: "services.manage", status: "implemented" },
  { id: "security", label: "الأمان", icon: Settings2, segment: "account/security", permission: null, status: "implemented" },
  { id: "sessions-devices", label: "الجلسات والأجهزة", icon: UserRound, segment: "account/sessions-devices", permission: null, status: "implemented" },
];

export function platformStaffEntryPath(entry: PlatformStaffNavEntry): string {
  return entry.segment ? `${platformStaffDashboardBase}/${entry.segment}` : platformStaffDashboardBase;
}

/** Presentation-only filter: the server already refuses unauthorized requests with 403. */
export function visiblePlatformStaffEntries(permissions: readonly string[]): PlatformStaffNavEntry[] {
  return platformStaffNavEntries.filter((entry) => entry.permission === null || permissions.includes(entry.permission));
}
