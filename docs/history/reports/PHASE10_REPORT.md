# تقرير المرحلة 10 — تصلب وتنظيف الإرث وتوثيق الخطة

**الحالة:** منفذة بانتظار اعتماد المالك والالتزام فقط.
**التاريخ:** 2026-08-21
**قاعدة الاختبار:** فرع Neon المعزول `development` فقط؛ لم تُنفذ أي migration ولم يُستخدم فرع الإنتاج للاختبارات أو `TRUNCATE`.
**مرجع Git السابق:** `8ebb08ac91622bba25539ff4e3511474e90c3747`.

## الملخص

نظّمت المرحلة 10 حوكمة المشروع وملفات التقرير، وأغلقت ثغرات اختبار موثقة من 9A، ونظفت التبعيات غير المستوردة، ثم صلّبت الخادم المركب من دون تغيير schema أو Prisma أو migrations أو إضافة ميزة جديدة. بقيت تحذيرات البناء المتعلقة بحجم JavaScript والتحذير غير المباشر `tar@7.5.1` موثقة ومؤجلة؛ لم تُخفَ ولم تُعالج بترقية خارج النطاق.

| مجال البوابة | النتيجة |
|---|---|
| حوكمة الوثائق | **Passed** — أودعت الخطة الرسمية وBacklog في `docs/`، ونقلت تقارير وبوابات الجذر إلى `docs/history/reports/`. |
| تغطية اختبارات 9A | **Passed** — وُجدت التغطية؛ أضيفت الاختبارات الناقصة فقط ثم مرّت على `development`. |
| تنظيف الحزم | **Passed بشـرط موثق** — أزيلت الحزم غير المستوردة وتحذير `pnpm` المهيأ؛ بقي تحذير `tar` غير المباشر المسموح بتوثيقه. |
| قالب الخادم | **Passed** — لا يوجد `server/_core` ولا tRPC/OAuth/StorageProxy في main أو مسار الإنتاج. |
| تصلب الخادم | **Passed** — حد JSON = `1mb`، وفشل EADDRINUSE صريح بلا منفذ بديل، وAPI وSPA يمران من الخادم المركب. |
| البوابة النهائية | **Passed** — `pnpm check` و`phase1:typecheck` و`build` وكل اختبارات 1–9B والخادم المركب خضراء. |

## 1. وثائق الحوكمة والبنية

أصبح المصدر الرسمي للخطة في `docs/CODIQ_FULL_PLAN_26_PHASES.md`، ويثبت أن **المرحلة 10 هي الحالية والمرحلة 11 هي CI/CD**. أودع `docs/BACKLOG.md` مع بقاء تعليماته ملزمة: السجل ليس أمر تنفيذ. أضيف B-12 بالحالة **📋** لتقييم ترقية Tailwind لمعالجة `tar` في المرحلة 21، من دون ترقية في المرحلة الحالية.

نُقلت تقارير المراحل ووثائق البوابات من الجذر إلى `docs/history/reports/`، ومنها `PHASE8A_REPORT.md` و`PHASE8B_REPORT.md` و`PHASE9A_REPORT.md` و`PHASE9B_REPORT.md` و`HANDOFF_REPORT.md` وملفات بوابات 9B و10. لم تُعثر بعد النقل على مراجع Markdown داخلية تشير إلى المواقع القديمة.

## 2. تحقق الاختبارات المنجزة سابقاً

| المطلوب | موضع التغطية النهائي | دليل آخر تشغيل على `development` |
|---|---|---|
| سباق overselling بين سلتين مستقلتين | `phase1-backend/tests/phase9b.browser-acceptance.mjs`، UI-06 (`stockCheckoutD`/`stockCheckoutE`). | `201` ثم `422 INSUFFICIENT_AVAILABLE_STOCK`. |
| guest checkout مباشر | `phase1-backend/tests/phase9a.storefront.integration.mjs`، `guestCheckout`. | `401 CUSTOMER_SESSION_REQUIRED`. |
| Idempotency-Key مع payload مختلف | `phase1-backend/tests/phase9a.storefront.integration.mjs`، `idempotencyPayloadMismatch`. | `409 IDEMPOTENCY_KEY_REUSED` بلا order أو reservation إضافي. |
| IDOR لعنوان عميل آخر | `phase1-backend/tests/phase9b.browser-acceptance.mjs`، `addressCheckout`. | `404`. |
| قائمة طلبات العميل وعزلها | `phase1-backend/tests/phase9a.storefront.integration.mjs`، `customerOrdersPageOne` و`customerOrdersPageTwo`؛ وعزل المتجر في `crossStoreSession`. | صفحتا cursor `200/200` بلا تكرار، وعزل المتجر `403`. |
| حارس قاعدة الاختبار المشترك | `phase1-backend/tests/helpers/test-database-guard.ts` و`development-database-connection.test.ts`. | اختباران Passed: قبول `development` ثم رفض مضيف الإنتاج قبل أي اتصال. |

أضيفت فقط التغطية التي لم تكن موجودة فعلياً: guest checkout المباشر، payload مختلف لمفتاح idempotency، وcursor pagination لقائمة الطلبات. كل السكربتات التي تنفذ `TRUNCATE` تستخدم الحارس؛ لا يقبل الحارس رابطاً إلا إذا حمل علامة اختبار معتمدة أو مضيف development المعتمد، ويرفض مضيف الإنتاج أولاً.

## 3. تنظيف التبعيات والبناء

كانت `drizzle-orm` و`drizzle-kit` و`mysql2` غائبة أصلاً من `package.json`، ولذلك لم يُنفذ حذف صوري لها. ثبت البحث في كود التشغيل وملفات البناء فقط عدم استيراد الحزم التالية، ثم أزيلت من manifest وlockfile: `axios` و`@hookform/resolvers` و`framer-motion` و`nanoid` و`tailwindcss-animate` و`streamdown` و`recharts` و`@tailwindcss/typography` و`add` و`autoprefixer` و`pnpm` و`postcss` و`vite-plugin-manus-runtime` و`@builder.io/vite-plugin-jsx-loc`.

حُذف `client/src/components/ui/chart.tsx` بعد إثبات أنه لا يملك أي مستورد داخل `client/src/`. ستعود مكونات الرسوم البيانية فقط عند الحاجة التشغيلية الفعلية لمراحل التقارير **17+**. نُقلت `patchedDependencies` و`overrides` بالقيم نفسها من حقل `pnpm` المهمل إلى `pnpm-workspace.yaml`، ما أزال تحذير إعداد pnpm.

| تحقق Tailwind/PostCSS | النتيجة |
|---|---|
| الإصدار وآلية التحميل | `tailwindcss 4.1.14` عبر `@tailwindcss/vite 4.1.14` و`tailwindcss()` في `vite.config.ts`. |
| ملفات أو إعداد PostCSS | لا `postcss.config.*` ولا مفتاح `postcss` مستخدم في Vite؛ لذا حذف `postcss` و`autoprefixer` آمن. |
| CSS قبل/بعد | قبل التنظيف `132,265` بايت؛ بعده `129,181` بايت، فرق تقريبي 2.3% مع ملف CSS غير فارغ. |
| تثبيت pnpm | نجح. التحذير الوحيد المتبقي هو `tar@7.5.1` غير المباشر من `@tailwindcss/oxide`. |

> **تحذير معروف غير حاجز:** لم تُرقّ Tailwind لمجرد إسكات `tar`، تنفيذاً للقرار. أضيفت المراجعة إلى `docs/BACKLOG.md` كبند B-12 للمرحلة 21.

يبقى تحذير Vite لحجم chunk JavaScript فوق 500 kB. لم يُضف تقسيم chunks في هذه المرحلة لأنه تحسين أداء خارج نطاق التصلب والتنظيف؛ وهو مرشح للتقييم في مرحلة الأداء/البنية الأمامية المناسبة.

## 4. مسار الخادم والتصلب

أكد التدقيق أن `server/` يحتوي `server/index.ts` فقط، ولا يوجد مجلد `server/_core` أو ملف يحمل tRPC أو OAuth أو StorageProxy. يبني `package.json` الخادم من `server/index.ts`، وهو يركب `phase1-backend/src/http/app.ts` تحت `/api` ويخدم SPA من `dist/public`. بذلك تُغلق ملاحظة قالب الخادم نهائياً على حالة main الحالية.

| تغيير | الملف | الدليل |
|---|---|---|
| حد JSON | `phase1-backend/src/http/app.ts` | `express.json({ limit: "1mb" })`. لا توجد payloads JSON شرعية كبيرة؛ صور المنتج تمر عبر `multer` multipart بحد 5MB لكل صورة. |
| منفذ مشغول | `server/index.ts` | `server.once("error")` يطبع رسالة تتضمن رقم المنفذ عند `EADDRINUSE` ثم ينهي العملية برمز `1`، بلا تبديل أو إعادة محاولة. |
| دليل تشغيلي | `phase1-backend/tests/phase10.composite-server.runtime.mjs` | API `404` JSON لمتجر مفقود، SPA `200` HTML، والإقلاع الثاني على المنفذ نفسه يخرج برمز غير صفري وبالرسالة الصريحة. |

## 5. الأرشفة وقرارات ADR

لم يُعثر على أي ملف مطابق لـ`publish_phase*.js`، لذا لم يكن هناك سكربت نشر قديم لينقل إلى `archive/legacy-scripts/`. يظل النشر المستقبلي خارج هذه المرحلة ومخصصاً لـCI/CD في المرحلة 11.

أضيفت القرارات التالية:

| ADR | الحالة | القرار |
|---|---|---|
| `docs/adr/ADR-001-completed-returned-window.md` | مؤجل إلى المرحلة 17 | `completed → returned` لا يعيد المخزون تلقائياً؛ يبقى `pending_inspection`. |
| `docs/adr/ADR-002-remove-legacy-customer-aliases.md` | معتمد ومنفذ في 9B | aliases القديمة حذفت نهائياً؛ المسار المعتمد هو Storefront المحمي بالـcookie والعزل ودمج السلة. |

## 6. قرارات البوابات

> **قرار بوابة تنظيف package.json:** «streamdown — احذفها؛ غير مستوردة إطلاقًا فلا مبرر لبقائها. recharts وchart.tsx — احذفهما معًا بشرط دليل واحد: أثبت بالبحث في كامل client/src أن chart.tsx نفسه غير مستورد من أي ملف آخر؛ إن كان غير مستورد فاحذف الملف والحزمة معًا، وسجّل في التقرير أن مكونات الرسوم البيانية ستُعاد إضافتها عند الحاجة الفعلية في مراحل التقارير (17+) — كود غير مستخدم اليوم أفضل خارج المستودع. ... tar — لا تحذفها ولا ترقِّ Tailwind الآن ... وثّقها في التقرير كتحذير تبعية غير مباشرة معروف وغير حاجز، وأضف سطرًا في docs/BACKLOG.md بحالة 📋: "تقييم ترقية Tailwind لإزالة تحذير tar — مرشح للمرحلة 21".»

> **قرار بوابة مسار الخادم:** «موافقة — نفّذ بنود التصلب الثلاثة فقط دون أي حذف ملفات: (1) معالج EADDRINUSE في server/index.ts ... لا تبديل منفذ صامتًا ولا إعادة محاولة. (2) express.json({ limit: "1mb" }) ... تحقق أن رفع صور المنتجات لا يتأثر لأنه يمر عبر multipart لا JSON. (3) الدليل التشغيلي: اختبار يثبت إقلاع الخادم المركب وخدمة /api وSPA معًا بنجاح، ثم محاولة إقلاع ثانية على نفس المنفذ تفشل بالرسالة الواضحة.»

## 7. بوابة الاختبارات النهائية

| الفحص | النتيجة |
|---|---|
| `pnpm check` | Passed |
| `pnpm phase1:typecheck` | Passed |
| `pnpm build` | Passed؛ CSS النهائي 129,181 بايت |
| `pnpm phase1:test` | Passed |
| `pnpm phase5:test` | Passed |
| `pnpm phase6:test` و`phase6:browser` | Passed |
| `pnpm phase7:test` و`phase7:browser` | Passed |
| `pnpm phase8a:test` | Passed |
| `pnpm phase8b:browser` | Passed — M-01–M-22 وO-01–O-07 وU-01–U-04 |
| `pnpm phase9a:test` | Passed — checkout/hardening/delivery/IDOR/cursor/hard guard |
| `pnpm phase9b:browser` | Passed — UI-01 إلى UI-07 |
| `phase10.composite-server.runtime.mjs` | Passed — API `404`، SPA `200`، process ثانٍ exit `1` |

## 8. الحالة المتبقية والخطوة التالية

لا يوجد migration أو تعديل Neon إنتاجي أو feature جديدة في هذه المرحلة. لا يوجد commit أو push بعد. **المرحلة 11** هي CI/CD حسب `docs/CODIQ_FULL_PLAN_26_PHASES.md`، ولم يبدأ تنفيذها. يبقى كل العمل الحالي في الشجرة للمراجعة والاعتماد الصريح قبل الالتزام.

## المصادر الداخلية

- `docs/CODIQ_FULL_PLAN_26_PHASES.md`
- `docs/BACKLOG.md`
- `docs/history/reports/PHASE10_PACKAGE_CLEANUP_GATE.md`
- `docs/history/reports/PHASE10_SERVER_TEMPLATE_GATE.md`
- `phase1-backend/tests/phase9a.storefront.integration.mjs`
- `phase1-backend/tests/phase9b.browser-acceptance.mjs`
- `phase1-backend/tests/phase10.composite-server.runtime.mjs`
