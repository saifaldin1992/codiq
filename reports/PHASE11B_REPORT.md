# تقرير المرحلة 11B — Railway Staging

**الحالة:** جاهزية staging مُثبتة تشغيلياً، وproduction بقيت مرتبطة بالمستودع مع تعطيل auto-deploy بناءً على تأكيد المالك. يظل PR #3 مفتوحاً بانتظار مراجعة المالك وإذن دمج صريح.

## الملخص التنفيذي

أنشئت بيئة Railway مستقلة باسم `staging` في المشروع الصحيح `successful-compassion` وربطت خدمة `CODIQ` بالمستودع `phsaifaldin/CODIQ` وفرع `main`. نشرت Railway الالتزام الظاهر لديها `04abdaa8` بنجاح، وأصبحت الخدمة Online على النطاق العام `https://codiq-staging.up.railway.app`. نجح فحص Railway الداخلي على `/api/health`، وأثبت الفحص الخارجي المستقل الاستجابة `{"status":"ok","env":"staging"}`. [1]

يحافظ الإعداد على عزل staging: لا ترث الخدمة متغيرات production، وتحتوي متغيراتها العشرة على أسرار staging التي أدخلها المالك عبر Railway فقط. استعمل النشر أمر التشغيل `NODE_ENV=staging node dist/index.js` لتفادي تثبيت `NODE_ENV=production` الموجود في سكربت `start` بالمستودع. لم تُنسخ أسرار إلى GitHub أو التقارير أو ملفات المشروع. [1] [2]

## النطاق المنفذ

| البند | النتيجة المثبتة | الدليل |
|---|---|---|
| Health endpoint | `GET /api/health` يعيد حالة البيئة قبل middleware | `phase1-backend/src/http/app.ts` [2] |
| Prisma في Railway | `postinstall: prisma generate` موجود؛ فشل Prisma السابق لم يتكرر في النشر الحالي | `package.json` وسجل Railway [1] [2] |
| بيئة staging | بيئة مستقلة وخدمة جديدة مرتبطة بـ`main` | Railway findings [1] |
| الأسرار | عشرة متغيرات staging أضيفت في Railway من دون عرض قيمها | Railway findings [1] |
| أمر التشغيل | `NODE_ENV=staging node dist/index.js` في Railway staging فقط | Railway findings [1] |
| Healthcheck Railway | `/api/health` نجح من المحاولة الأولى | سجل النشر [1] |
| Public Domain | `https://codiq-staging.up.railway.app` | Railway findings [1] |
| فحص CI العام | وظيفة `ci / staging healthcheck` بعد التكامل وغير حاجبة مؤقتاً | `.github/workflows/ci.yml` [3] |
| توثيق التشغيل | `docs/DEPLOYMENT.md` يعكس المسار الفعلي وحدود production | هذه المرحلة [4] |
| النشر إلى production | بقي Source Repo مرتبطاً؛ أكد المالك ظهور `Enable` بعد تعطيل auto-deploy | تأكيد المالك وتوثيق Railway [1] |

## نتيجة النشر والتحقق

| التحقق | النتيجة | الحالة |
|---|---|---|
| تثبيت التبعيات | `pnpm install --frozen-lockfile --prefer-offline` نجح | Passed |
| بناء التطبيق | `pnpm run build` نجح | Passed |
| حالة Railway | Online / Active | Passed |
| Railway healthcheck | `/api/health` نجح من المحاولة الأولى | Passed |
| الفحص الخارجي | `GET https://codiq-staging.up.railway.app/api/health` أعاد 200 و`env: staging` | Passed |
| `ci / integration` | PostgreSQL المؤقت، migrations، typecheck، build، واختبارات التكامل اجتازت | Passed |
| `ci / staging healthcheck` | تحقّق `curl` من endpoint العام بعد التكامل | Passed / Non-blocking |
| `ci / browser acceptance` | فشلت Browser — phase 6؛ الوظيفة ظاهرة وغير حاجبة وفق B-15 | Failed / Non-blocking |

## تحقق الفرع المحلي

أظهر التحقق الأول أن اختبار بيانات لوحة المتابعة الذي أضيف مع لوحة المعمارية يستورد ملف TypeScript بامتداد `.ts`، بينما يستعمل `phase1:typecheck` دقة NodeNext التي تتطلب امتداد JavaScript في الاستيرادات النسبية. صُحح الاستيراد إلى `.js` فقط؛ لم يتغير منطق الاختبار أو الواجهة. بعد الإصلاح اجتازت الأوامر التالية: `git diff --check` و`pnpm check` و`pnpm phase1:typecheck` واختبار Vitest الخاص ببيانات لوحة المتابعة (اختباران)، ثم `pnpm build`. [5]

احتفظ البناء بتحذير bundle القائم حول chunk أكبر من 500kB؛ لم ينشأ هذا التحذير في 11B ولا يعطل البناء، وهو دين أداء معروف خارج نطاق هذه المرحلة. [5]

## العزل والقيود

لم يُستخدم مشروع Railway آخر، ولم تدخل متغيرات production إلى staging. فُتحت production لاحقاً بتفويض صريح لا يجيز إلا تعطيل auto-deploy. أكد المالك نجاح العملية من جلسته بعد أن تغيّر الزر إلى `Enable`، وهو رمز Railway للنشر التلقائي المعطل. تعذر على جلسة المنفذ إعادة التحقق لأن Railway عرضت عطلها المؤقت؛ لذلك يوثق التقرير مصدر الدليل بصراحة. بقي Source Repo موصولاً ولم تُلمس المتغيرات أو قاعدة البيانات أو النطاق أو النشر القائم. لا يُنشر إلى production إلا يدوياً وبعد موافقة المالك الصريحة.

ميزة **Wait for CI** في Railway لم تُفعّل؛ إذ تطلبت موافقة صلاحيات GitHub جديدة. هذا لا يضعف حماية `main`: فـ`ci / integration` يظل شرط حماية GitHub قبل أي دمج. أما Railway فهو ينشر ما يصل إلى `main` تلقائياً في staging فقط. لا تُعالج المرحلة B-15 الخاصة باستقرار اختبارات المتصفح.

## قرارات البوابات

> قم بحل مشكلة بيئة الاختبار (Staging) في المرحلة 11B وتأكيد جاهزيتها لنتمكن من الانتقال للمراحل التالية بأمان.

فسرت هذه الموافقة على أنها تخويل لإنشاء وتكوين staging فقط داخل المشروع الصحيح، وتوليد نطاقها العام ونشرها والتحقق منها. جاء لاحقاً تفويض مستقل وصريح للتحقق من production وتعطيل النشر التلقائي فيها فقط؛ لم يشمل ذلك نشر production أو تغيير متغيراتها أو قاعدة بياناتها.

## الملفات المضافة أو المعدلة في PR المقترح

| الملف | الوصف |
|---|---|
| `.github/workflows/ci.yml` | فحص endpoint staging بعد التكامل وبشكل غير حاجب مؤقتاً |
| `docs/DEPLOYMENT.md` | توثيق مسار Railway staging الفعلي وحدود production |
| `reports/RAILWAY_ACCESS_FINDINGS.md` | أدلة الوصول والإعداد والنشر والتحقق الخارجي |
| `reports/PHASE11B_REPORT.md` | هذا التقرير |
| `phase1-backend/tests/engineering-roadmap-data.test.ts` | تصحيح امتداد استيراد متوافق مع NodeNext لاستعادة `phase1:typecheck` |
| `todo.md` | سجل متابعة 11B |

## ما يتطلب متابعة قبل إغلاق 11B رسمياً

نجح CI على Pull Request الذي يتضمن فحص الصحة الجديد، ويجب الآن مراجعة التقرير والـPR من مالك المشروع. لا يُدمج أي تغيير قبل موافقته الصريحة. بعد الدمج، سيكون من الملائم التحقق من أن النشر التلقائي في staging يعكس التغيير المدمج، بينما تبقى production يدوية النشر فقط.

**نتيجة Pull Request:** فُتح PR #3 بعنوان `chore(phase11b): verify Railway staging health and deployment path`. تشغيل CI رقم `32564102509` انتهى بالحالة العامة Success: `ci / integration` نجحت خلال 1m54s و`ci / staging healthcheck` نجحت خلال 4s. فشلت وظيفة المتصفح غير الحاجبة في Browser — phase 6، وهو نفس الدين المسجل مسبقاً تحت B-15؛ لم يمنع ذلك PR أو يحجب `main`. [6]

## المراجع

[1]: ./RAILWAY_ACCESS_FINDINGS.md "أدلة Railway staging والنشر الأول"
[2]: ../package.json "أوامر النشر وتوليد Prisma" 
[3]: ../.github/workflows/ci.yml "فحوص CI وStaging healthcheck"
[4]: ../docs/DEPLOYMENT.md "النشر وبيئات CODIQ"
[5]: أوامر التحقق المحلي للفرع `phase11b-staging` في 22 أغسطس 2026
[6]: https://github.com/phsaifaldin/CODIQ/actions/runs/32564102509 "تشغيل CI لـPR #3"
