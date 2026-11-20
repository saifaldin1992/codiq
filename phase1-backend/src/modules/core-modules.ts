/**
 * The CORE modules: every route file that existed under `http/routes/` before
 * modules did, wrapped one-to-one and listed in their ORIGINAL registration
 * order. Express matches in registration order, so this order is behaviour —
 * `module-registry.unit.mjs` pins it. Do not reorder; append new modules in
 * `registry.ts`, after this list.
 *
 * Each entry names the domain it belongs to, so the platform's shape is
 * readable in one place even though the files have not moved (ten repository
 * guards and the OpenAPI generator read those paths; moving them is churn with
 * no behavioural gain).
 */
import { defineModule } from "./platform-module.js";
import { registerAuthRoutes } from "../http/routes/auth.js";
import { registerSessionRoutes } from "../http/routes/sessions.js";
import { registerOwnerSecurityRoutes } from "../http/routes/owner-security.js";
import { registerAccountSecurityRoutes } from "../http/routes/account-security.js";
import { registerPosRoutes } from "../http/routes/pos.js";
import { registerReturnInspectionRoutes } from "../http/routes/return-inspection.js";
import { registerStorefrontRoutes } from "../http/routes/storefront.js";
import { registerStoreBannerRoutes } from "../http/routes/store-banners.js";
import { registerPlatformRoutes } from "../http/routes/platform.js";
import { registerPublicRoutes } from "../http/routes/public.js";
import { registerWebhookRoutes } from "../http/routes/webhooks.js";
import { registerMerchantRoutes } from "../http/routes/merchant.js";
import { registerTeamRoutes } from "../http/routes/team.js";
import { registerNotificationRoutes } from "../http/routes/notifications.js";
import { registerOrderRoutes } from "../http/routes/orders.js";
import { registerCatalogRoutes } from "../http/routes/catalog.js";
import { registerMarketingRoutes } from "../http/routes/marketing.js";
import { registerCustomerDelightRoutes } from "../http/routes/customer-delight.js";
import { registerReviewAndWishlistRoutes } from "../http/routes/reviews-wishlist.js";
import { registerReturnRoutes } from "../http/routes/returns.js";
import { registerTrashRoutes } from "../http/routes/trash.js";
import { registerPlatformStaffRoutes } from "../http/routes/platform-staff.js";
import { registerOpenApiRoutes } from "../http/routes/openapi.js";
import { registerPlatformServicesRoutes } from "../http/routes/platform-services.js";
import { registerStorefrontConfigRoutes } from "../http/routes/storefront-config.js";
import { registerPaymentMethodRoutes } from "../http/routes/payment-methods.js";
import { registerStoreTrafficRoutes } from "../http/routes/store-traffic.js";
import { registerMerchantHomeRoutes } from "../http/routes/merchant-home.js";

export const CORE_MODULES = [
  defineModule({ id: "auth", domain: "identity", title: "الدخول والتسجيل لكل الهويّات", register: registerAuthRoutes }),
  defineModule({ id: "sessions", domain: "identity", title: "الجلسات والأجهزة والخروج", register: registerSessionRoutes }),
  defineModule({ id: "owner-security", domain: "identity", title: "أمان مالك المنصّة (المصادقة الثنائية والاستعادة)", register: registerOwnerSecurityRoutes }),
  defineModule({ id: "account-security", domain: "identity", title: "تغيير كلمة المرور واستعادتها", register: registerAccountSecurityRoutes }),
  defineModule({ id: "pos", domain: "pos", title: "نقطة البيع (الكاشير) وأجهزتها", register: registerPosRoutes }),
  defineModule({ id: "return-inspection", domain: "pos", title: "فحص المرتجعات وإعادتها للمخزون", register: registerReturnInspectionRoutes }),
  defineModule({ id: "storefront", domain: "storefront", title: "واجهة المتجر: الكتالوج والسلّة والشراء وحساب الزبون", register: registerStorefrontRoutes }),
  defineModule({ id: "store-banners", domain: "storefront", title: "لافتات واجهة المتجر", register: registerStoreBannerRoutes }),
  defineModule({ id: "platform", domain: "platform", title: "لوحة المالك: التجّار والخطط والمال", register: registerPlatformRoutes }),
  defineModule({ id: "public", domain: "platform", title: "صفحات المنصّة العامّة (الخطط، التواصل، التسجيل)", register: registerPublicRoutes }),
  defineModule({ id: "webhooks", domain: "operations", title: "استقبال إشعارات مزوّد البريد", register: registerWebhookRoutes }),
  defineModule({ id: "merchant", domain: "platform", title: "حساب التاجر ومتاجره", register: registerMerchantRoutes }),
  defineModule({ id: "team", domain: "team", title: "فريق المتجر وصلاحيّاته", register: registerTeamRoutes }),
  defineModule({ id: "notifications", domain: "operations", title: "إعدادات الإشعارات وسجلّها", register: registerNotificationRoutes }),
  defineModule({ id: "orders", domain: "orders", title: "الطلبات ودورة حياتها", register: registerOrderRoutes }),
  defineModule({ id: "catalog", domain: "catalog", title: "المنتجات والتصنيفات والمخزون", register: registerCatalogRoutes }),
  defineModule({ id: "marketing", domain: "marketing", title: "الكوبونات والبكسلات والسلال المتروكة", register: registerMarketingRoutes }),
  defineModule({ id: "customer-delight", domain: "storefront", title: "تتبّع الطلب للزبون", register: registerCustomerDelightRoutes }),
  defineModule({ id: "reviews-wishlist", domain: "storefront", title: "التقييمات والمفضّلة والولاء", register: registerReviewAndWishlistRoutes }),
  defineModule({ id: "returns", domain: "orders", title: "طلبات الإرجاع", register: registerReturnRoutes }),
  defineModule({ id: "trash", domain: "operations", title: "سلّة المحذوفات وسجلّ النشاط", register: registerTrashRoutes }),
  defineModule({ id: "platform-staff", domain: "team", title: "طاقم المنصّة وسجلّ تدقيقها", register: registerPlatformStaffRoutes }),
  defineModule({ id: "openapi", domain: "operations", title: "وثيقة الواجهة البرمجيّة", register: registerOpenApiRoutes }),
  defineModule({ id: "platform-services", domain: "platform", title: "الخدمات والإتاحة وأعلام الميزات والصيانة", register: registerPlatformServicesRoutes }),
  defineModule({ id: "storefront-config", domain: "storefront", title: "هويّة واجهة المتجر وصفحاته", register: registerStorefrontConfigRoutes }),
  defineModule({ id: "payment-methods", domain: "finance", title: "طرق الدفع في المتجر", register: registerPaymentMethodRoutes }),
  defineModule({ id: "store-traffic", domain: "storefront", title: "عدّاد الزيارات", register: registerStoreTrafficRoutes }),
  defineModule({ id: "merchant-home", domain: "platform", title: "الصفحة الرئيسيّة للتاجر", register: registerMerchantHomeRoutes }),
] as const;
