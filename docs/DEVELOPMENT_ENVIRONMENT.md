# بيئة التطوير والتشخيص المحلية — CODIQ

**أُنشئت:** 2026-08-27 · **السبب:** أول إعادة إنتاج محلية لفشل CI (بوابة متصفح 20B) كشفت علتين ما كانت سجلات CI لتكشفهما.

## المكونات (Windows)

| المكوّن | الغرض | التثبيت |
|---|---|---|
| PostgreSQL 16 | قاعدة الاختبار المحلية | مثبت كخدمة `postgresql-x64-16` (postgres/postgres) وقاعدة `codiq_ci_test` |
| pnpm 10.4.1 | مدير الحزم — **عالمياً** لا عبر corepack فقط | `npm install -g pnpm@10.4.1` (السكربتات المتداخلة تستدعي `pnpm` من PATH) |
| Playwright Chromium | اختبارات القبول المتصفحية | `pnpm exec playwright install chromium` |
| Python 3.12 + moto | محاكي التخزين S3 الذي تحتاجه اختبارات الصور والوصفات | مثبت من python.org (متجر ويندوز معطل) ثم `pip install "moto[server,s3]"` |

## تشغيل أي حزمة اختبار محلياً

```powershell
$env:PATH = "$env:APPDATA\npm;$env:LOCALAPPDATA\Programs\Python\Python312\Scripts;$env:PATH"
$url = "postgresql://postgres:postgres@localhost:5432/codiq_ci_test?schema=public"
$env:DATABASE_URL = $url; $env:CODIQ_POSTGRES_URL = $url
$env:CODIQ_POSTGRES_URL_UNPOOLED = $url; $env:CODIQ_TEST_DATABASE_URL = $url
$env:SESSION_JWT_SECRET = "codiq-local-repro-secret-not-for-production"
$env:CODIQ_ALLOW_OWNER_REGISTRATION = "true"
$env:CODIQ_PRODUCTION_DATABASE_URL = "postgresql://x:x@production-forbidden.invalid:5432/x"
$env:CODIQ_TEST_ARTIFACTS_DIR = "<مجلد اللقطات>"
pnpm phase20b:browser   # أو أي phaseNN:test / phaseNN:browser
```

اسم القاعدة يحتوي `test` فيقبله حارس قاعدة الاختبار؛ متغير الإنتاج يبقى وهمياً دائماً.

## دروس مستخلصة (تُراجع قبل كتابة أي اختبار جديد)

1. **الاختبار الذي يرفع ملفاً يجب أن يشغّل moto بنفسه** وينشئ الحاوية ويمرر `PRODUCT_S3_*` للخادم — بنمط `phase7.product-management.integration.mjs`؛ تثبيت moto في CI لا يعني تشغيله.
2. **عناصر النموذج المتحكَّم بها خادمياً** (`checked={state}`) لا تُختبر بـ`.check()` — انقر، انتظر تأكيد الحفظ، ثم تحقق.
3. الحزم الثقيلة تمسح `storefront_rate_limits` قبل كل طلب كتابة.
4. قيود `CHECK` تُوسَّع بهجرة عند إضافة قيمة تعدادية جديدة (درس `cart.abandoned`).
5. الحقول المضافة تكسر مقارنات `deepEqual` الصارمة في الاختبارات القديمة — يُبحث عنها قبل الدفع.
6. **العملية المولّدة عبر `shell: true` على ويندوز لا يقتلها `child.kill()`** — يُقتل الغلاف فقط ويبقى moto ممسكاً بالمنفذ، فتتحدث الجولة التالية مع محاكي الجولة السابقة وتفشل بعيداً عن السبب. تُستعمل `killTree()` من `tests/helpers/child-process.mjs` دائماً. (على لينكس/CI السلوك لم يتغير.)
7. **النص المرئي ليس معرّفاً**: `getByText` يلتقط الفقرات التعريفية وتلميحات البطاقات الأخرى، فيموت الاختبار بـstrict mode أو — أسوأ — ينجح على العنصر الخطأ عبر `.first()`. يُستهدف `data-testid` ويُتحقق من القيمة **داخل** العنصر المقصود.
8. **كل حزمة متصفح تلتقط دليلاً عند الفشل**: عنوان كل صفحة مفتوحة ونصوص `role="alert"` ولقطة كاملة — بنمط كتلة `catch` في `phase20b.browser-acceptance.mjs`. فشل بلا دليل يكلّف ساعة تخمين.
9. **قاعدة اختبار واحدة لكل منفّذ متوازٍ.** كل حزمة تبدأ بـ`TRUNCATE ... CASCADE`؛ فإذا شغّل عميلان حزمتين على `codiq_ci_test` نفسها، محا أحدهما بيانات الآخر في منتصف الجولة وظهر الفشل كخطأ منطقي كاذب (مالك سُجّلت بنجاح ثم فشل دخولها). القاعدة: قاعدة باسم مستقل لكل شجرة عمل — `codiq_gate_test`, `codiq_md1_test` — تُمرَّر عبر `CODIQ_TEST_DATABASE_URL`. حارس قاعدة الاختبار يقبل أي اسم يحتوي `test`.

10. **الطابع الزمني في القاعدة أدقّ من ساعة JS.** أعمدة `timestamptz(6)` تخزّن الميكروثانية بينما `Date` في JS يقف عند الميلي، فاختبار يُدرج صفاً ثم يستدعي المعالج بـ`new Date()` في الميلي نفسها يقارن `.494000 >= .494832` فلا يلتقط شيئاً — تذبذب يظهر مرة كل ثلاث جولات تقريباً. العامل الحقيقي يعمل بمؤقّت كل خمس ثوانٍ ولا يقع في هذه النافذة أبداً، فالاختبار يمرّر `now` متقدّماً بثانية بدل أن يتظاهر بأنه يقع فيها.
11. **⚠️ لا تُعدّل ملفاً عربياً عبر PowerShell 5.1 إطلاقاً.** `Get-Content -Raw` يفكّ ترميز UTF-8 بترميز ويندوز المحلي، فتصبح «متجر» → `ظ…طھط¬ط±`؛ ثم `Set-Content -Encoding utf8` يكتب ذلك التلف إلى القرص. الملف يبدو سليماً في مخرجات PowerShell ويكون **تالفاً فعلاً**. القاعدة: التعديل بأدوات المحرّر (Edit/Write) دائماً، وPowerShell للتشغيل والفحص لا للكتابة. وللتحقق من ملف عربي بعد أي عملية، يُقرأ بأداة تفكّ UTF-8 صحيحاً لا بـ`Get-Content`.

12. **⚠️ خادم بدأتَه يدوياً في الخلفية يظلّ يستهلك طابور الإشعارات بعد انتهاء الحزمة.** حزم متصفح ثلاث (`phase6` و`phase13`) لا تُشغّل خادماً بنفسها بل تنتظر واحداً على منفذ ثابت، فيُشغَّل يدوياً — ومعه يبدأ `outbox-worker` و`abandoned-cart-scanner` و`trash-purger`. وإن بقي حيّاً، فهو يسحب صفوف `notification_outbox` **من الحزم التالية** ويضعها `skipped` قبل أن يصل إليها مزوّدها الوهمي، فتفشل `phase15` و`phase17` و`phase20b2` و`cd1` بأخطاء تبدو منطقية («البريد لم يُسلَّم») بلا صلة بسببها. وأسوأ ما فيه أنها **تنجح منفردة** وتفشل في السرب، فتُقرأ كتذبذب لا كتلوّث.
    **والسبب التقني للتسريب:** `$!` في Git Bash يعيد معرّف مهمة الصدفة لا معرّف عملية node، فـ`taskkill /PID $!` يقتل شيئاً آخر ويخرج بنجاح ظاهري.
    **القاعدة:** يُقتل الخادم **بالمنفذ** لا بـ`$!` — `netstat -ano | grep :PORT` ثم `taskkill /PID <pid> /T /F` — ويُتحقّق من خلوّ المنفذ قبل تشغيل أي حزمة تالية. وهذا نفس درس 6 بوجه آخر: عملية خلفية تنجو من محاولة قتلها تُفسد جولة لاحقة بعيداً عن سببها.

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -d postgres -c "CREATE DATABASE codiq_<اسم>_test;"
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/codiq_<اسم>_test?schema=public"
pnpm exec prisma migrate deploy --schema prisma/schema.prisma   # لا تستعمل phase1:db:migrate: يحتاج `sh` غير المتاح في PowerShell
```

## حالة البوابات في CI (2026-08-27)

| الوظيفة | حاجبة؟ |
|---|---|
| `ci / integration` (كل حزم التكامل) | **نعم** |
| `ci / browser acceptance` | **نعم** — حاجبة منذ 2026-09-04 |
| `ci / staging healthcheck` | لا — `continue-on-error: true` |

بوابة المتصفح **حاجبة** منذ 2026-09-04، بعد إحدى عشرة تشغيلة على `main` عشرٌ منها خضراء — الشرط الذي كان مكتوباً هنا قد استوفي، والسجلّ في `.github/workflows/ci.yml`. فشغّل حزم المتصفح محلّياً قبل الدفع؛ لن تمرّ انحدارات الواجهة بصمت بعد الآن. والوظيفة الوحيدة التي تحمل `continue-on-error` هي `ci / staging healthcheck`، لأنّها مجسّ على بيئةٍ خارج هذه الدورة.
