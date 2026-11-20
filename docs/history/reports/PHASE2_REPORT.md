# codiq — تقرير إنجاز المرحلة الثانية: هيكل لوحة مالك المنصة

**حالة المرحلة:** مكتملة محليًا ومتحقق منها بصريًا ومرفوعة إلى GitHub.  
**النطاق المنفذ:** هيكل لوحة مالك المنصة، شريط جانبي RTL، مسارات صفحات placeholder، وأكورديون رئيسي واحد مفتوح.  
**خارج النطاق عمدًا:** قاعدة البيانات، المصادقة الفعلية، أي بيانات حقيقية، أو منطق أعمال، أو إضافة/تعديل/حذف، أو لوحة التاجر.

> راجعت commit المرحلة الأولى المعتمد `344b2a3` قبل التنفيذ. لم تُغيّر طبقات PostgreSQL أو المصادقة في هذه المرحلة؛ التغيير محصور في واجهة التنقل التجريبية.

## 1. مسارات الصفحات المنفذة

كل مسار أدناه يعرض الغلاف الثابت للوحة المالك: الشريط الجانبي الأيمن، سياق الصفحة، عنوانها، وبطاقة Placeholder عربية. أي صفحة لا تحمل بيانات فعلية أو أزرار تنفيذية.

| القسم | تسمية الصفحة | المسار |
|---|---|---|
| CODIQ | الرئيسية | `/platform/dashboard` |
| التجار والمتاجر | التجار | `/platform/dashboard/merchants` |
| التجار والمتاجر | إضافة تاجر | `/platform/dashboard/merchants/add` |
| التجار والمتاجر | طلبات التسجيل | `/platform/dashboard/merchants/registration-requests` |
| التجار والمتاجر | المتاجر | `/platform/dashboard/stores` |
| التجار والمتاجر | إضافة متجر | `/platform/dashboard/stores/add` |
| التجار والمتاجر | التحقق | `/platform/dashboard/verification` |
| التجار والمتاجر | إدارة التجار | `/platform/dashboard/merchant-management` |
| الطلبات | جميع الطلبات | `/platform/dashboard/orders` |
| الطلبات | بحاجة لإجراء | `/platform/dashboard/orders/action-needed` |
| الطلبات | قيد المعالجة | `/platform/dashboard/orders/processing` |
| الطلبات | قيد التنفيذ | `/platform/dashboard/orders/fulfillment` |
| الطلبات | قيد التوصيل | `/platform/dashboard/orders/out-for-delivery` |
| الطلبات | مكتملة | `/platform/dashboard/orders/completed` |
| الطلبات | ملغاة | `/platform/dashboard/orders/cancelled` |
| الطلبات | مرتجعة | `/platform/dashboard/orders/returned` |
| الطلبات | الإرجاع | `/platform/dashboard/orders/returns` |
| الطلبات | التسليم | `/platform/dashboard/orders/delivery` |
| الطلبات | التقارير | `/platform/dashboard/orders/reports` |
| الاشتراكات والمالية | الاشتراكات | `/platform/dashboard/subscriptions` |
| الاشتراكات والمالية | الخطط | `/platform/dashboard/plans` |
| الاشتراكات والمالية | طلبات الترقية | `/platform/dashboard/upgrade-requests` |
| الاشتراكات والمالية | الفواتير | `/platform/dashboard/invoices` |
| الاشتراكات والمالية | المدفوعات | `/platform/dashboard/payments` |
| الاشتراكات والمالية | العمولات | `/platform/dashboard/commissions` |
| الاشتراكات والمالية | التسويات | `/platform/dashboard/settlements` |
| الاشتراكات والمالية | التقارير المالية | `/platform/dashboard/financial-reports` |
| المنصة ← الموقع التعريفي | الصفحات | `/platform/dashboard/site/pages` |
| المنصة ← الموقع التعريفي | محرر الموقع | `/platform/dashboard/site/editor` |
| المنصة ← الموقع التعريفي | التصميم | `/platform/dashboard/site/design` |
| المنصة ← الموقع التعريفي | الوسائط | `/platform/dashboard/site/media` |
| المنصة ← الموقع التعريفي | SEO | `/platform/dashboard/site/seo` |
| المنصة ← الموقع التعريفي | النشر والإصدارات | `/platform/dashboard/site/publishing-versions` |
| المنصة | إعدادات المنصة | `/platform/dashboard/platform-settings` |
| المنصة | النطاقات والروابط | `/platform/dashboard/domains-links` |
| المنصة | التكاملات | `/platform/dashboard/integrations` |
| المنصة | المطورون | `/platform/dashboard/developers` |
| المنصة | النظام والصيانة | `/platform/dashboard/system-maintenance` |
| حسابي | الملف الشخصي | `/platform/dashboard/account/profile` |
| حسابي | الأمان | `/platform/dashboard/account/security` |
| حسابي | الجلسات والأجهزة | `/platform/dashboard/account/sessions-devices` |
| حسابي | الإشعارات | `/platform/dashboard/account/notifications` |
| حسابي | اللغة | `/platform/dashboard/account/language` |
| حسابي | تسجيل الخروج | `/platform/dashboard/account/sign-out` |

## 2. الأكورديون والتنقل

استُخدم مكوّن الأكورديون الجاهز من Radix بإعداد `type="single"` و`collapsible`. لذلك لا يمكن فتح سوى قسم رئيسي واحد في الوقت نفسه؛ عند فتح `الطلبات` بعد `التجار والمتاجر` ينطوي القسم الأول تلقائيًا. تعتمد الحركة على حالات `data-state` الخاصة بالمكوّن، وتستخدم انتقال فتح وطي مع تدوير سهم القسم خلال 220ms تقريبًا.

التحقق البصري التقط حالتين على سطح مكتب بعرض 1440px: الأولى بالرابط `/platform/dashboard?open=merchants` وتظهر فروع **التجار والمتاجر** فقط؛ والثانية بالرابط `/platform/dashboard?open=orders` وتظهر فروع **الطلبات** فقط، بينما قائمة التجار مطوية. كما تحقق الرابط `/platform/dashboard/site/pages` من الصفحة المتداخلة ضمن `المنصة ← الموقع التعريفي` ومن تغيّر العنوان والسياق إلى `الصفحات` داخل الغلاف العربي نفسه.

## 3. التحقق التقني

| التحقق | النتيجة |
|---|---|
| `pnpm check` | نجح؛ لا أخطاء TypeScript. |
| `pnpm build` | نجح؛ بُنيت واجهة Vite وإخراج الخادم. |
| المسار المتداخل `/platform/dashboard/site/pages` | ظهر في غلاف لوحة المالك، لا في صفحة 404. |
| الشريط الجانبي RTL | ظاهر وثابت على سطح المكتب، ويظهر كلوحة قابلة للفتح على الشاشات الأصغر. |
| البيانات والمنطق | غير موصولين عمدًا، التزامًا بحدود المرحلة. |

## 4. هوية الواجهة

تعتمد الواجهة اتجاه **أسطح One UI الهادئة** الموثق في `ideas.md`: خط IBM Plex Sans Arabic، خلفية رمادية زرقاء فاتحة، بطاقات بيضاء ذات زوايا 20–28px، لون `Codiq Signal Blue #1E6FDB` للحالة النشطة فقط، وعلامة هندسية زرقاء مستقلة. استُخدمت أصول مرئية مولدة للعلامة ومساحة العنوان وبطاقة الـplaceholder، بدون أي صور عملاء أو تقييمات أو بيانات مصطنعة.

## 5. حدود المرحلة التالية

رُفع كود الواجهة في commit `add3fe999789151887f3e07f15e1647dc8220d4b` برسالة `feat(phase2): add owner dashboard navigation shell` بعد فحوص TypeScript واختبار انحدار المرحلة الأولى. لم أبدأ لوحة التاجر أو أي مرحلة ثالثة، وينتظر المشروع موافقتك الصريحة.
