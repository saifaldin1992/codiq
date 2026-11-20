# تقرير PHASE 9B النهائي — واجهة Storefront وحساب العميل

**الحالة:** مكتمل تنفيذياً ومجتاز بوابة الاختبارات المحددة، لكنه **غير ملتزم و غير مدفوع إلى GitHub** بانتظار مراجعة مالك المشروع وموافقته الصريحة.
**مرجع آخر commit موجود قبل هذه التغييرات:** `92bccfcad3b3fe46bfc64720c4fbb3c229d4ee28` — `fix(phase9a): lock checkout products before availability check`.
**بيئة الاختبار:** فرع Neon المعزول `development` عبر `CODIQ_TEST_DATABASE_URL` فقط. لم يُستخدم اتصال الإنتاج ولم تنفذ أي عملية `TRUNCATE` على production.

> جميع الوقائع التالية مشتقة من ملفات المشروع ومخرجات أوامر الاختبار الفعلية في هذه الجلسة. لا يحتوي التقرير على أي رابط اتصال أو مفتاح أو كلمة مرور.

## 1. النطاق المنفذ

تم بناء واجهة Storefront عربية بهوية One UI فوق API المرحلة 9A ومساراتها تحت `/store/:storeSlug/...`. تشمل الواجهة الكتالوج، تفاصيل المنتج، سلة الضيف، التسجيل والدخول بالهاتف، دمج سلة الضيف من الخادم، العناوين، Checkout COD، سجل الطلبات، وتفاصيل الطلب مع timeline آمن. لا تستخدم الواجهة `localStorage` أو رموز Bearer؛ تعتمد طلبات same-origin وCookies من نوع HttpOnly. المصدر: `client/src/lib/storefront-api.ts`، `client/src/components/StorefrontProvider.tsx`، `client/src/components/StorefrontShell.tsx`، و`client/src/pages/Storefront*.tsx`.

تمت إضافة تسعير التوصيل ضمن معاملة checkout نفسها من جدول `delivery_rates` المقيد بـ`store_id + governorate`. يأخذ النظام لقطة `delivery_fee_iqd` عند إنشاء الطلب ويحسب `total_iqd = subtotal_iqd + delivery_fee_iqd`. إذا لم يوجد rate مفعّل للمحافظة، يعيد الخادم `422 DELIVERY_UNAVAILABLE_FOR_GOVERNORATE`. لا توجد migration أو schema change، لأن الجدول والحقول كانت موجودة فعلاً. المصدر: `phase1-backend/src/services/storefront.service.ts`، `prisma/schema.prisma`.

| المجال | التنفيذ الفعلي | المصدر |
|---|---|---|
| المسارات الأمامية | ربط مسارات الكتالوج والسلة والمصادقة والـcheckout والطلبات داخل `StorefrontWrapper`. | `client/src/App.tsx` |
| الجلسات والسلة | Cookie guest وCookie customer يستخدمان `/api/store/<slug>` في الإنشاء والمسح، بما فيه logout. | `phase1-backend/src/http/app.ts`; `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs` |
| aliases القديمة | حذف `POST /stores/:storeSlug/account/register` و`POST /stores/:storeSlug/account/login` نهائياً؛ اختبارهما الآن يعيد `404`. | `phase1-backend/src/http/app.ts`; `phase1-backend/tests/phase1.integration.ts` |
| هوية العميل | إزالة مسارات/فروع `requirePhone:false`؛ تسجيل ودخول العميل يفرضان الهاتف على مسارات Storefront. | `phase1-backend/src/auth/auth.service.ts` |
| التوصيل | endpoint quote مقيد بالجلسة والعنوان: `GET /store/:storeSlug/account/addresses/:addressId/delivery-quote`. | `phase1-backend/src/http/app.ts`; `client/src/lib/storefront-api.ts` |
| Checkout UI | عرض إجمالي المنتجات، رسوم التوصيل، الإجمالي النهائي، ورسالة عربية عند عدم توفر المحافظة قبل التأكيد. | `client/src/pages/StorefrontCheckoutPage.tsx` |
| Regression 8B | إصلاح مرجع endpoint المستقر في قائمة الطلبات، لمنع إعادة تحميل متكررة كانت تمنع empty state لمرشح التاريخ. | `client/src/components/OrderWorkspace.tsx` |

## 2. قرارات البوابات

### بوابة الخطوة 3 — aliases تسجيل العميل

> قراري لبوابة الخطوة 3: الحذف النهائي للمسارين القديمين، مسبوقًا بفحص المستهلكين الذي طلبتَه ضمنًا. نفّذ بالترتيب: (1) ابحث في كامل المستودع — client/ وtests/ وserver/ وshared/ — عن أي استدعاء أو إشارة للمسارين /stores/:storeSlug/account/register و/login. (2) إن وُجدت إشارات في اختبارات قديمة، حدّثها لتستهدف مسارات Storefront المحمية /store/... بسلوكها الكامل (هاتف إلزامي، كوكي، merge) — تحديث الاختبار للواقع الجديد لا العكس. (3) إن كشف البحث مستهلكًا فعليًا غير الاختبارات لا يمكن تحديثه، توقف واعرضه عليّ قبل أي حذف. (4) بعد خلو البحث أو تحديث الاختبارات: احذف المسارين من app.ts حذفًا كاملًا لا تعطيلًا، واحذف فرعي requirePhone:false من auth.service إن لم يعد لهما مستدعٍ. (5) أضف اختبارًا سلبيًا يثبت أن المسارين المحذوفين يعيدان 404. المبررات المسجلة للقرار: تدقيقك نفسه أثبت غياب مستهلك معروف، والإبقاء عليهما — ولو موحّدين — يحافظ على نمط access token في الجسم المخالف لنموذج الكوكي المعتمد، وسطحُ دخولٍ مزدوج قبل وجود أي مستخدم إنتاجي هو دين أمني بلا دائن. سجّل هذا النص حرفيًا في قسم قرارات البوابات بالتقرير، وتابع لبوابة الخطوة 4.

**نتيجة التنفيذ:** لم يظهر مستهلك فعلي خارج تعريفَي المسارين. تم تحديث اختبار المرحلة 1 لمسارات Storefront المحمية مع الهاتف وCookie ودمج سلة ضيف، وحذف aliases والفروع القديمة. أظهر الاختبار `404` لكلا alias، و`201` لتسجيل العميل، و`409 DUPLICATE_CUSTOMER_PHONE` للتكرار داخل المتجر، و`201` للهاتف نفسه في متجر آخر. المصدر: `phase1-backend/tests/phase1.integration.ts` ومخرجات `pnpm phase1:test`.

### بوابة الخطوة 4 — رسوم التوصيل

> قراري لبوابة الخطوة 4: الخيار A — أضِف التسعير الآن ضمن 9B. النطاق الدقيق المسموح: (1) عند checkout يُقرأ سعر التوصيل من delivery_rates حسب governorate عنوان التسليم للمتجر نفسه؛ إن كانت المحافظة معطلة (is_enabled=false) أو بلا صف، يُرفض الـcheckout بـ422 برمز DELIVERY_UNAVAILABLE_FOR_GOVERNORATE. (2) تُخزن القيمة لقطةً في delivery_fee_iqd للطلب ويصبح total_iqd = subtotal_iqd + delivery_fee_iqd. (3) القراءة والحساب داخل نفس معاملة الـcheckout القائمة، ولا migration جديدة ما دامت الحقول موجودة — وإن لزم حقل، فadditive فقط حسب القاعدة العامة. (4) idempotency تبقى سليمة: إعادة نفس Idempotency-Key تعيد نفس الطلب بنفس رسوم التوصيل الملتقطة، حتى لو تغيّر سعر المحافظة بين المحاولتين. (5) اختباران على الأقل: محافظة مفعلة بسعر يظهر صحيحًا في delivery_fee_iqd والإجمالي، ومحافظة معطلة تُرفض بـ422 بالرمز المحدد. (6) واجهة 9B تعرض سطر التوصيل والإجمالي بوضوح قبل زر تأكيد الطلب، وتعرض رسالة عربية مفهومة عند رفض المحافظة. سجّل هذا القرار حرفيًا في قسم قرارات البوابات، وتابع للخطوة 5.

**نتيجة التنفيذ:** الاختبار يثبت محافظة `Baghdad` مفعلة برسوم `2500`، لقطة order بقيمة `deliveryFeeIqd=2500` و`totalIqd=32500`، ثم تغيّر rate إلى `9000` قبل replay لكن إعادة المفتاح نفسه أعادت الرسوم الملتقطة `2500`. المحافظة المعطلة أعادت `422 DELIVERY_UNAVAILABLE_FOR_GOVERNORATE`. المصدر: `phase1-backend/tests/phase9a.storefront.integration.mjs` ومخرجات `pnpm phase9a:test`.

## 3. نتائج اختبارات القبول UI-01 إلى UI-07

| الاختبار | النتيجة | الدليل الفعلي |
|---|---|---|
| UI-01 | **Passed** | كتالوج → سلة ضيف → تسجيل → دمج → عنوان → quote توصيل → Checkout → تفاصيل order. |
| UI-02 | **Passed** | RTL، عرض `390×844`، labels وfocus عبر لوحة المفاتيح، وعدم وجود horizontal overflow (`documentWidth <= viewportWidth`). |
| UI-03 | **Passed** | طلبا checkout متزامنان بالمفتاح نفسه أعادا `201` و`200` مع `order.id` واحد. |
| UI-04 | **Passed** | Customer-B تلقى `404` عند `orderId` لـCustomer-A، و`404` عند استعمال عنوان Customer-A في checkout بسلة صالحة. |
| UI-05 | **Passed** | Cookie متجر A لا ترسل لمسار متجر B (`401`)، وBearer Customer-A على Store-B أعاد `403`، وعلى merchant endpoint أعاد `403`. |
| UI-06 | **Passed** | لقطة سعر السلة بقيت `4000` بعد تغيير السعر؛ المنتج غير الفعال أعاد `422`; منافسة المخزون المحدود أعادت `201` ثم `422`. |
| UI-07 | **Passed** | history العميل لم يتضمن `actorKind` أو `actorId` أو `note`. |

**ملف الاختبار:** `phase1-backend/tests/phase9b.browser-acceptance.mjs`.
**الأمر الناجح:** `pnpm phase9b:browser` مع متغيرات اتصال development فقط.
**نتيجة العزل:** `order=404`، `addressCheckout=404`، `tokenCrossStore=403`، `tokenMerchant=403`، مع عدم إرسال Cookie إلى store مختلف (`401`).

## 4. اختبار Cookies المحدود

اجتاز `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs` بعد توحيد Path. أثبت إنشاء Cookie guest وCookie customer على `/api/store/<slug>`، وصولهما إلى API المطابق، دمج سلة guest، المسح الفعلي بعد logout، وعدم إرسال Cookie إلى متجر آخر أو API غير ذي صلة. المصدر: مخرجات الاختبار: `guestCart.issued=true`، `customerSession.logoutCleared=true`، `foreignStoreCookieSent=false`، `unrelatedApiCookieSent=false`.

## 5. Regression والبناء

| البوابة | النتيجة | أبرز الأدلة |
|---|---|---|
| `pnpm check` | **Passed** | TypeScript للواجهة بلا أخطاء. |
| `pnpm phase1:typecheck` | **Passed** | TypeScript للخلفية بلا أخطاء. |
| `pnpm build` | **Passed مع تحذير** | Vite/esbuild نجحا؛ JS النهائي `846.59 kB` غير مضغوط، أعلى من حد تحذير 500 kB. |
| `pnpm phase1:test` | **Passed** | عزل الهوية، 404 aliases المحذوفة، phone uniqueness وguest merge. |
| `pnpm phase5:test` | **Passed** | IDOR merchant/store `403/404` وإشراف owner. |
| `pnpm phase6:test` | **Passed** | provisioning وIDOR وboundary owner/merchant. |
| `pnpm phase7:test` | **Passed** | عزل التصنيفات/المنتجات والصور والمخزون. |
| `pnpm phase8a:test` | **Passed** | transitions المحظورة `422`، concurrency `200/409`، Triggers `23514`. |
| `pnpm phase8b:browser` | **Passed** | كل M-01–M-22 وO-01–O-07 وU-01–U-04؛ أصلح empty state لمرشح التاريخ. |
| `pnpm phase9a:test` | **Passed** | CO-05 حتمي `422 PRODUCT_UNAVAILABLE` بلا order/reservation؛ replay `200`؛ oversell والحجز وIDOR والقيود سليمة. |
| `pnpm phase9b:browser` | **Passed** | UI-01…UI-07 كما في القسم 3. |

## 6. سلامة بيئة الاختبار

أضيف حارس مشترك في `phase1-backend/tests/helpers/test-database-guard.ts` ويستدعى قبل `TRUNCATE` في اختبارات التكامل. يقبل الحارس رابطاً يحمل `development` أو `test` أو `phase`، أو مضيف فرع development المعتمد، ويرفض مضيف الإنتاج دائماً قبل فتح اتصال. اختبر الحارس قبول development ورفض مضيف production ممسوخ. كما مرّ اختبار اتصال Vitest الخفيف `phase1-backend/tests/development-database-connection.test.ts`.

لا توجد migration جديدة، ولا تعديل لـ`prisma/schema.prisma`، ولا تغيير Neon production، ولا تغيير متغيرات بيئة الإنتاج أو أي dependency جديدة.

## 7. الملفات المتغيرة قبل commit

### ملفات متتبعة معدلة

`PHASE9_FINAL_SPECIFICATION.md`، `client/src/App.tsx`، `client/src/components/OrderWorkspace.tsx`، `package.json`، `phase1-backend/src/auth/auth.service.ts`، `phase1-backend/src/http/app.ts`، `phase1-backend/src/services/storefront.service.ts`، اختبارات المراحل 1 و5 و6 و7 و8A و8B و9A، و`todo.md`.

### ملفات جديدة غير متتبعة

يشمل ذلك طبقة API ومكونات وصفحات Storefront تحت `client/src/`، حارسي اختبارات development، اختبارات Cookie وbrowser للمرحلة 9B، وثائق البوابات والتسليم والتقارير: `HANDOFF_REPORT.md` و`PHASE9B_COOKIE_PATH_BLOCKER.md` و`PHASE9B_COOKIE_PATH_FIX_REPORT.md` و`PHASE9B_STEP3_ALIAS_GATE.md` و`PHASE9B_STEP4_DELIVERY_GATE.md` وهذا التقرير.

## 8. حالة Git والتوصية التالية

`git status --short` **غير نظيف**، كما هو متوقع قبل commit المراجعة؛ لا يوجد commit أو push لهذه المرحلة. رأس الشجرة ما زال `92bccfcad3b3fe46bfc64720c4fbb3c229d4ee28`. لا ينبغي تنفيذ `git add` أو commit أو push قبل مراجعة هذا التقرير والموافقة الصريحة.

التحذيران غير الحاجزين المتبقيان هما تحذير حجم bundle الإنتاجي (`846.59 kB`) وتحذير pnpm المتعلق بمفتاح إعداد legacy في `package.json`. لا يمثل أي منهما فشلاً وظيفياً أو أمنياً، ولم يُنفذ refactor خارج النطاق لمعالجتهما.

**الخطوة التالية:** مراجعة مالك المشروع للتقرير و`git status`، ثم — فقط عند الموافقة الصريحة — تحديد الملفات النهائية للـcommit ورسالة الـcommit، وإنشاء commit واحد، ثم مراجعة الدفع بصورة منفصلة.
