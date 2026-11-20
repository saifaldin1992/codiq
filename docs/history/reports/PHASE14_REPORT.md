# تقرير المرحلة 14 — الموظفون والصلاحيات الدقيقة والتنقل المركزي

**الحالة:** التنفيذ مكتمل على الفرع `phase14-staff-permissions-navigation` وكل بوابات القبول المحلية خضراء. **غير مدمجة** — بانتظار مراجعة المالك وإنشاء PR وموافقة صريحة على الدمج وفق دستور المشروع.

**سياق إعادة البناء:** التنفيذ الأول للمرحلة اكتمل واختُبر ثم فُقد بالكامل لأنه بقي worktree غير محفوظ عند sandbox reset (موثق في Recovery Audit وFinal Closure Report بحكم NOT CLOSED / BLOCKED). أعيد البناء هذه المرة بالقاعدة الحاكمة: **commit + push فوري لكل وحدة عمل** — كل السجل أدناه مدفوع فعلاً إلى GitHub.

## سجل الالتزامات المدفوعة

| Commit | المحتوى |
|---|---|
| `5ec7f6a` | الخطوة 1 — تصحيح Schema Drift: نماذج Prisma الأربعة + مجلدا الهجرة `20260824154500_phase14_staff_permissions_navigation` و`20260824160000_phase14_staff_order_actor` بمحتوى مطابق حرفياً للمعاينة المعتمدة المطبقة على Neon staging |
| `4093d82` | الخطوة 2 — الخلفية: هوية staff وجلساتها المقيدة بالعضوية، المحلّل المركزي `staff-permissions.ts`، `loginStaff` مستقل، `staff.service.ts` لإدارة الفريق، retrofit المسارات المعتمدة، وactor حقيقي في أحداث الطلبات |
| `ec733b0` | الخطوة 3 — الواجهة: `client/src/config/navigation.ts` مصدر تنقل وحيد تستهلكه لوحات المالك والتاجر والموظف (إغلاق فجوة P0)، `StaffDashboard`، `StoreTeamManager`، دخول staff، ومسارات `/staff/*` |
| `f1dc3e5` | الخطوة 4 — الاختبارات: مصفوفة تكاملية شاملة + قبول متصفحي + تحديث تنظيف حزم 1/5/6 + إثبات trigger البريد للـstaff + نقل حزم المتصفح لمسارات قابلة للتهيئة |
| `31614fe` | الخطوة 5 — تشغيل أخضر: إصلاح عقد inventory في الاختبار و`.first()` للشريطين المكررين في Playwright strict mode |

## D14-01 إلى D14-07 — التنفيذ

| القرار | أين نُفذ |
|---|---|
| هوية مستقلة (D14-01) | `staff` + `staff_sessions` + `IdentityKind = "staff"` في `redirects.ts`/`identity.ts` |
| بريد فريد عالمياً (D14-02) | Trigger `codiq_guard_owner_merchant_staff_email` بقفل استشاري يغطي الجداول الثلاثة |
| دوران فقط (D14-03) | `STAFF_ROLE_CODES` + قيد CHECK في القاعدة |
| مصفوفة 11 code (D14-04) | `ROLE_PERMISSION_MATRIX` + قيد CHECK على `permission_code` |
| كلمة مرور مؤقتة (D14-05) | `createStoreStaff` (بريد normalized، 12+ حرفاً، لا تغيير كلمة سر موظف قائم) |
| عضويات متعددة وجلسة مقيدة (D14-06) | UNIQUE(staff, store) + جلسة تحمل membershipId/storeId وتُرفض خارجهما |
| رفض فوري (D14-07) | تعطيل/تغيير دور ⇒ `revokedAt` لكل جلسات العضوية + تحقق نشاط حي في `requireStoreStaff` |

## عقود API الجديدة والمعدلة

| المسار | التفويض | النجاح | الرفض |
|---|---|---|---|
| `POST /api/auth/staff/stores/:slug/login` | بريد + كلمة مرور + متجر صريح | `200` وcookie جلسة و`redirectTo` | `401 INVALID_STAFF_CREDENTIALS`، `404 STAFF_STORE_CONTEXT_NOT_FOUND` |
| `GET /api/staff/stores/:slug/session` | جلسة staff حية | `200` هوية + دور + صلاحيات محسوبة خادمياً | `401` (منتهية/مبطلة/معطلة)، `403` لغير الموظف أو متجر آخر |
| `GET /api/staff/stores/:slug/dashboard` | جلسة staff حية | `200` | كما أعلاه |
| `GET/POST /api/merchant/stores/:slug/team` | مالك المتجر أو `team.manage` | `200/201` | `403 STAFF_PERMISSION_DENIED`، `409` تعارض بريد/عضوية مكررة |
| `PATCH .../team/:membershipId` | `team.manage` | `200` (تغيير دور/تفعيل يبطل الجلسات) | `404` خارج المتجر |
| `PUT .../team/:membershipId/overrides` | `team.manage` | `200` ويرفع `permission_version` | `422` code/effect غير صالح |
| retrofit: catalog / inventory / orders / customers/manual / products / images | `requireStoreActor` بالـcode المناسب | كما قبل المرحلة للتاجر | `403 STAFF_PERMISSION_DENIED` للموظف غير المخول |

خريطة الـretrofit: العرض ⇒ `catalog.products.view`، الإنشاء/التعديل/الحذف ⇒ codes المنتجات المقابلة، الصور ⇒ view/update، التصنيفات كتابةً ⇒ `catalog.categories.manage`، المخزون ⇒ `inventory.update`، الطلبات قراءةً ⇒ `orders.view` وتحويل الحالة ⇒ `orders.update`، الإضافة اليدوية للعميل ⇒ `customers.view` (أدق code متاح في المصفوفة المعتمدة — موثق كقرار خريطة)، الفريق ⇒ `team.manage`. `settings.manage` بلا سطح HTTP في المراحل 1–13 فيغطيه المحلّل حتى تظهر مساراته.

## بوابة القبول — النتائج الفعلية (قاعدة PostgreSQL 16 محلية معزولة، كل الهجرات التسع عبر `prisma migrate deploy` ثم `migrate status` نظيف)

| الفحص | النتيجة |
|---|---:|
| `pnpm check` / `pnpm phase1:typecheck` / `pnpm build` | PASS |
| مصفوفة المحلّل: 11 code × 4 أبعاد (أساس المدير، أساس الموظف، سماح فوق الدور، منع فوق الدور) | **44/44 PASS** |
| مصفوفة API الحية: مدير 10/10 إيجابي، موظف 4 إيجابي + 6 سلبي `403 STAFF_PERMISSION_DENIED`، سماح 6/6، منع 10/10 | PASS |
| دخول staff مستقل + رفض دخوله عبر مسار التاجر | PASS |
| انتهاء صلاحية حقيقي على مستوى القاعدة (fixture created_at < expires_at < now) | `401` PASS |
| token تالف / جلسة مبطلة | `401` PASS |
| تعطيل العضوية يقطع الجلسة الحية فوراً، والدخول بعده يرفض | `401` / `404` PASS |
| إعادة التفعيل لا تُحيي جلسة مبطلة؛ تغيير الدور يقطع الجلسات ويُحمّل المصفوفة الجديدة | PASS |
| عزل: متجر ثانٍ لنفس التاجر `403`، متجر تاجر آخر بلا عضوية إطلاقاً `403`/دخول `404` | PASS |
| حدود الهوية: staff على مسارات التاجر/المالك `403 IDENTITY_BOUNDARY_DENIED` والعكس | PASS |
| حقن storeId/membershipId/role في الجسم لا يغير السياق الخادمي | PASS |
| تعدد العضويات: عضوية ثانية `201`، التكرار `409`، وكل جلسة تبقى مقيدة بمتجرها | PASS |
| تعارض البريد: staff↔owner `409`، staff↔merchant `409`، تسجيل تاجر ببريد staff `409`، وSQL مباشر `23505 CODIQ_EMAIL_CONFLICT` | PASS |
| تدقيق الطلبات: `actor_kind=staff` بالمعرف الحقيقي و`updated_by_kind=staff`؛ مسار التاجر يبقى `merchant` | PASS |
| `pnpm phase14:browser`: التاجر ينشئ موظفاً من واجهة الفريق ← دخول الموظف ← ظهور orders/products/inventory وغياب customers/team/settings ← نقل حالة طلب حقيقي `200` بحدث staff ← نداء Team API مباشر `403` ← تعطيل العضوية `401` وإعادة توجيه للدخول (4 لقطات في `.test-artifacts/`) | PASS |
| الانحدار التكاملي: `phase1` `phase5` `phase6` `phase7` `phase8a` `phase9a` `phase13` | PASS جميعها |
| انحدار المتصفح: `phase6` `phase8b` `phase9b` (+cookie) `phase13` | PASS جميعها |
| صحة staging قراءةً: `GET /api/health` ⇒ `{"status":"ok","env":"staging"}` (بيئة staging ما تزال تشغّل آخر main — النشر يتم عند الدمج فقط) | PASS |

## قاعدة البيانات وstaging

- الهجرتان في الكود مطابقتان حرفياً للمعاينة المعتمدة التي طبقها المالك على فرع Neon `staging` بتاريخ 2026-08-24، والقيدان مسجلان هناك مسبقاً في `_prisma_migrations` بالاسمين نفسيهما (تحقق المالك المباشر الموثق في التعليمات). لذلك عند دمج الفرع سيجد `prisma migrate deploy` على staging الهجرتين مسجلتين ولن ينفذ أي DDL — التزامن مضمون بنيوياً، ولم يعد `migrate resolve --applied` لازماً.
- لم يجرِ أي اتصال أو عملية على Neon production أو الفرع الافتراضي، ولا أي DDL على staging خلال إعادة البناء؛ وصلة Railway استُخدمت قراءةً لأسماء المتغيرات فقط (القيم محجوبة).

## انحرافات وإصلاحات harness (محصورة بالاختبارات، أسوة بسابقة المراجعة النهائية التاريخية)

1. حزم المتصفح كانت تثبّت مسارات Linux (`/usr/bin/chromium`، `/home/ubuntu/...`) — أصبحت قابلة للتهيئة عبر `CODIQ_CHROMIUM_PATH` و`CODIQ_TEST_ARTIFACTS_DIR` مع بقاء افتراضات Linux كما هي لـCI.
2. أعيد تطبيق إصلاح تاريخي مفقود: مالك فريد لكل تشغيل داخل `phase6.browser-flow.mjs`.
3. تنظيف حزم 1/5/6 يشمل جداول staff (قيد FK RESTRICT على stores)، واختبار المرحلة 1 يثبت الآن trigger البريد على جدول staff أيضاً.
4. الحارس يتطلب `CODIQ_PRODUCTION_DATABASE_URL` بمضيف مغاير عند التشغيل المحلي — استُخدم مضيف حارس صوري `production-guard-placeholder.invalid`.

## المتبقي لإغلاق المرحلة (قرارات المالك)

1. مراجعة المالك لهذا التقرير والفرع.
2. إنشاء PR من `phase14-staff-permissions-navigation` إلى `main` (رابط المقارنة جاهز) واجتياز `ci / integration` الحاجب.
3. موافقة صريحة على الدمج ⇒ staging تنشر تلقائياً وتتأكد مطابقة الهجرات.
4. لا نشر production ضمن هذه المرحلة.
