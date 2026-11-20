# codiq — تقرير إنجاز المرحلة الثالثة: هيكل لوحة التاجر

**الحالة:** مكتملة محليًا ومتحقق منها بصريًا ومرفوعة إلى GitHub.  
**النطاق:** شريط جانبي للوحة التاجر، Store Switcher بصري فقط، صفحات placeholder، ومسارات وأكورديون واحد مفتوح.  
**خارج النطاق عمدًا:** بيانات متجر أو تاجر حقيقية، ربط قاعدة بيانات، منطق طلبات/منتجات/عملاء، تبديل متجر فعلي، أو وظائف إنشاء/حذف/تعديل.

> راجعت commit المرحلة الأولى `344b2a3` وcommit المرحلة الثانية `add3fe9` قبل التنفيذ. بقيت طبقات الهوية وقاعدة البيانات دون تغيير؛ الإضافة محصورة في واجهة التاجر تحت النطاق `/merchant/dashboard`.

## 1. مسارات الصفحات المنفذة

كل المسارات أدناه تظهر في الغلاف نفسه للوحة التاجر: الشريط الجانبي العربي، علامة codiq، Store Switcher التجريبي، العنوان والسياق، وPlaceholder مقفل بلا بيانات أو أزرار تشغيلية.

| القسم | الصفحة | المسار |
|---|---|---|
| codiq — لوحة التاجر | الرئيسية | `/merchant/dashboard` |
| المتاجر | جميع المتاجر | `/merchant/dashboard/stores` |
| المتاجر | إنشاء متجر | `/merchant/dashboard/stores/create` |
| المتاجر | المتاجر النشطة | `/merchant/dashboard/stores/active` |
| المتاجر | المتاجر المعلّقة | `/merchant/dashboard/stores/suspended` |
| المتاجر | المتاجر المؤرشفة | `/merchant/dashboard/stores/archived` |
| المتاجر | إدارة المتجر | `/merchant/dashboard/stores/manage` |
| المتاجر | فريق المتجر | `/merchant/dashboard/stores/team` |
| الطلبات | جميع الطلبات | `/merchant/dashboard/orders` |
| الطلبات | بحاجة لإجراء | `/merchant/dashboard/orders/action-needed` |
| الطلبات | جديدة | `/merchant/dashboard/orders/new` |
| الطلبات | قيد المعالجة | `/merchant/dashboard/orders/processing` |
| الطلبات | قيد التجهيز | `/merchant/dashboard/orders/preparation` |
| الطلبات | قيد التوصيل | `/merchant/dashboard/orders/out-for-delivery` |
| الطلبات | مكتملة | `/merchant/dashboard/orders/completed` |
| الطلبات | ملغاة | `/merchant/dashboard/orders/cancelled` |
| الطلبات | مرفوضة | `/merchant/dashboard/orders/rejected` |
| الطلبات | الإرجاع | `/merchant/dashboard/orders/returns` |
| الطلبات | التسليم | `/merchant/dashboard/orders/delivery` |
| الطلبات | التسويات | `/merchant/dashboard/orders/settlements` |
| الطلبات | التقارير | `/merchant/dashboard/orders/reports` |
| المنتجات | جميع المنتجات | `/merchant/dashboard/products` |
| المنتجات | إضافة منتج | `/merchant/dashboard/products/add` |
| المنتجات | التصنيفات | `/merchant/dashboard/products/categories` |
| المنتجات | المخزون | `/merchant/dashboard/products/inventory` |
| المنتجات | العروض والكوبونات | `/merchant/dashboard/products/offers-coupons` |
| العملاء | جميع العملاء | `/merchant/dashboard/customers` |
| العملاء | العملاء الجدد | `/merchant/dashboard/customers/new` |
| العملاء | العملاء النشطون | `/merchant/dashboard/customers/active` |
| العملاء | العملاء المحتملون | `/merchant/dashboard/customers/prospects` |
| العملاء | السلات المتروكة | `/merchant/dashboard/customers/abandoned-carts` |
| التسويق | العروض | `/merchant/dashboard/marketing/offers` |
| التسويق | الكوبونات | `/merchant/dashboard/marketing/coupons` |
| التسويق | الحملات | `/merchant/dashboard/marketing/campaigns` |
| التسويق | التواصل | `/merchant/dashboard/marketing/communication` |
| التسويق | التقارير | `/merchant/dashboard/marketing/reports` |
| المتجر والمحتوى | مظهر المتجر | `/merchant/dashboard/storefront/appearance` |
| المتجر والمحتوى | القالب | `/merchant/dashboard/storefront/theme` |
| المتجر والمحتوى | صفحات المتجر | `/merchant/dashboard/storefront/pages` |
| المتجر والمحتوى | محرر الصفحات | `/merchant/dashboard/storefront/page-editor` |
| المتجر والمحتوى | القوائم والتنقل | `/merchant/dashboard/storefront/navigation` |
| المتجر والمحتوى | الوسائط | `/merchant/dashboard/storefront/media` |
| المتجر والمحتوى | SEO | `/merchant/dashboard/storefront/seo` |
| المتجر والمحتوى | النشر والإصدارات | `/merchant/dashboard/storefront/publishing-versions` |
| الإعدادات | إعدادات المتجر | `/merchant/dashboard/settings/store` |
| الإعدادات | الدفع | `/merchant/dashboard/settings/payments` |
| الإعدادات | التوصيل | `/merchant/dashboard/settings/shipping` |
| الإعدادات | الإشعارات | `/merchant/dashboard/settings/notifications` |
| الإعدادات | التكاملات | `/merchant/dashboard/settings/integrations` |
| الإعدادات | الاشتراك | `/merchant/dashboard/settings/subscription` |
| حسابي | الملف الشخصي | `/merchant/dashboard/account/profile` |
| حسابي | الأمان | `/merchant/dashboard/account/security` |
| حسابي | الجلسات والأجهزة | `/merchant/dashboard/account/sessions-devices` |
| حسابي | الإشعارات | `/merchant/dashboard/account/notifications` |
| حسابي | اللغة | `/merchant/dashboard/account/language` |
| حسابي | تسجيل الخروج | `/merchant/dashboard/account/sign-out` |

## 2. الأكورديون وStore Switcher

يستخدم الشريط الجانبي مكوّن Radix Accordion بالخصائص `type="single"` و`collapsible`، لذلك لا يفتح سوى قسم رئيسي واحد. التحقق البصري على سطح مكتب بعرض 1440px التقط الرابط `/merchant/dashboard?open=stores` مع فروع **المتاجر**، ثم الرابط `/merchant/dashboard?open=orders` مع فروع **الطلبات** وحدها، مؤكدًا انطواء قائمة المتاجر عند فتح الطلبات. تدعم الحركة فتحًا وطيًا ناعمًا عبر حالات `data-state` وانتقال قصير مدته 220ms.

يوجد Store Switcher في أعلى الشريط بعنوان **متجري الافتراضي** ووسم **تجريبي**. لا يقبل النقر ولا يغيّر السياق أو البيانات أو الجلسة؛ فهو عنصر بصري فقط ضمن حدود المرحلة.

## 3. عزل صفحات المتجر عن صفحات الموقع التعريفي

العزل موجود في التسمية والمسارات وعرض الواجهة معًا. صفحة التاجر هي فقط `/merchant/dashboard/storefront/pages` وتعرض سياق **المتجر والمحتوى ← صفحات المتجر** ونصًا صريحًا بأنها منفصلة بنيويًا عن صفحات الموقع التعريفي. بالمقابل، تظل صفحة المالك موجودة فقط في `/platform/dashboard/site/pages` بسياق **المنصة ← الموقع التعريفي**. لا يشتركان في مسار أو مكوّن شريط جانبي أو وجهة تنقل.

## 4. التحقق

| الفحص | النتيجة |
|---|---|
| `pnpm check` | نجح من دون أخطاء TypeScript. |
| `pnpm build` | نجح؛ بُنيت واجهة Vite والخادم. |
| لقطة `/merchant/dashboard/storefront/pages` | ظهرت داخل غلاف لوحة التاجر بعنوان «الصفحات» ووصف الفصل الصريح. |
| لقطتا حالة الأكورديون | أثبتتا أن «المتاجر» و«الطلبات» لا تظهران مفتوحتين معًا. |
| أي بيانات أو وظيفة فعلية | غير موجودة عمدًا. |

## 5. الحدود

رُفع كود الواجهة في commit `7ee5c12f556bd6a4f91dc63658a0b9524cb0db0a` برسالة `feat(phase3): add merchant dashboard navigation shell` بعد فحوص TypeScript واختبار انحدار المرحلة الأولى. لم تبدأ المرحلة الرابعة أو أي ميزة لاحقة، وينتظر المشروع موافقتك الصريحة.
