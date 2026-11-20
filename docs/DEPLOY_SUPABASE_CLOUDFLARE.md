# النشر: Supabase + Cloudflare + GitHub

```
المتصفّح ──► Cloudflare (DNS · CDN · WAF · نطاقات التجّار)
                 │
                 ▼
          Worker  (deploy/cloudflare/src/index.ts)
                 │  يوزّع الطلبات على INSTANCES نسخة
                 ▼
          Cloudflare Container  ← صورة Dockerfile في جذر المستودع
          (الخادم + عامل الإشعارات)
             │                │
             ▼                ▼
   Supabase Postgres     Cloudflare R2 (صور المنتجات · والنسخ الاحتياطيّة في حاوية منفصلة)

GitHub Actions:  ci  ──(نجح على release)──►  deploy: هجرات Supabase ثمّ wrangler deploy
                 backup: كلّ ٦ ساعات، تفريغ مُعمّى إلى R2
```

---

## ١. Supabase — قاعدة البيانات

1. أنشئ مشروعاً. اختر أقرب منطقة لمستخدميك (للعراق: أوروبا الوسطى عادةً هي الأقرب بين مناطق Supabase — راجع القائمة عند الإنشاء).
2. **الخطّة:** Pro للإنتاج. المجانيّة تُوقف المشروع بعد أسبوع بلا نشاط.
3. من **Connect** خذ رابطين:
   - **Transaction pooler** (المنفذ `6543`) ← `CODIQ_POSTGRES_URL` — أضِف في آخره `?pgbouncer=true&connection_limit=5`
   - **Direct / Session** (المنفذ `5432`) ← `CODIQ_POSTGRES_URL_UNPOOLED` وسرّ GitHub `SUPABASE_DB_URL_DIRECT`
4. ⚠️ **لا تضع `?schema=public` في الرابطين.** Supabase يضع الإضافات (`pg_trgm`، `btree_gist`) في مخطّط `extensions`،
   و`schema=public` يُخفيها عن الهجرات فيفشل فهرس البحث. سكربت الهجرة يكتشف هذه الحالة الآن ويرفض بوضوح مع طريقة الإصلاح.
   *(اختُبر: نفس الإعداد بلا `schema` يهاجر كاملاً وتنجح اختبارات البحث العربيّ والعزل.)*
5. لا تستخدم Supabase Auth ولا الوصول المباشر من المتصفّح (PostgREST): الخادم هو صاحب القرار، والهويّات مبنيّة داخل المنصّة.

## ٢. Cloudflare

### R2 — التخزين
أنشئ **حاويتين منفصلتين** ومفتاحَي API منفصلين:
- `…-images` لصور المنتجات ← `PRODUCT_S3_*` (endpoint: `https://<account-id>.r2.cloudflarestorage.com`، region: `auto`)
- `…-backups` للنسخ الاحتياطيّة ← `CODIQ_BACKUP_S3_*` — مفتاح لا يصل إليه الخادم أبداً.

### Workers + Containers
- يتطلّب خطّة **Workers Paid**.
- الإعداد في `deploy/cloudflare/wrangler.jsonc`: نوع النسخة `basic` (¼ vCPU، 1 GiB)، حتى ٤ نسخ، والطلبات موزّعة على `INSTANCES=2`.
  ارفع إلى `standard-1` (½ vCPU، 4 GiB) حين يكبر الحمل.
- **الأسرار** تُضبط مرّة واحدة (لا تُكتب في المستودع):
  ```bash
  cd deploy/cloudflare && npm ci
  for name in CODIQ_POSTGRES_URL CODIQ_POSTGRES_URL_UNPOOLED SESSION_JWT_SECRET CODIQ_ENCRYPTION_KEY \
              PRODUCT_S3_ENDPOINT PRODUCT_S3_BUCKET PRODUCT_S3_ACCESS_KEY_ID PRODUCT_S3_SECRET_ACCESS_KEY \
              CODIQ_RESEND_API_KEY CODIQ_MAIL_FROM CODIQ_PUBLIC_BASE_URL SENTRY_DSN; do
    npx wrangler secret put "$name"
  done
  ```
  الـWorker يمرّر إلى الحاوية **فقط** الأسماء المدرجة في `PASSTHROUGH` داخل `src/index.ts`.
- **الإيقاظ الدوريّ:** Cron كلّ ٥ دقائق يطلب `/api/ready` من `instance-0`، فتبقى مستيقظة ويبقى عامل الإشعارات يعمل.
  باقي النسخ تنام بعد ١٥ دقيقة خمول وتستيقظ مع أوّل طلب (بداية باردة لثوانٍ).

### النطاق ونطاقات التجّار
1. انقل DNS نطاقك إلى Cloudflare.
2. في الـWorker: **Custom Domain** للنطاق الرئيسيّ، و**Route** `*.example.com/*` للنطاقات الفرعيّة للمتاجر.
3. **نطاقات التجّار الخاصّة** (`shop.merchant.com`): **Cloudflare for SaaS → Custom Hostnames**، والـfallback origin هو الـWorker.
   Cloudflare يصدر الشهادة لكلّ نطاق تلقائياً. المنصّة تحلّ المتجر من الـHost (`storeForHost`).
4. `CODIQ_TRUSTED_EDGE=cloudflare` مضبوط في `wrangler.jsonc`: عنوان الزائر يُقرأ من `CF-Connecting-IP`، وعليه تُبنى حدود المعدّل.
5. **التخزين المؤقّت:** قراءات المتجر العامّة ترسل `s-maxage=60` (و`30` لإعدادات المتجر). فعّل في Cloudflare **Cache Rule**:
   «Eligible for cache» على `/api/store/*` مع احترام `Cache-Control` من الأصل. بدونها لا يخزّن Cloudflare ردود JSON.

## ٣. البريد
Cloudflare لا يرسل بريد التطبيق ولا Supabase. استخدم **Resend** (`CODIQ_RESEND_API_KEY`) أو أيّ SMTP (`CODIQ_SMTP_*`)،
وتحقّق من النطاق المرسِل (SPF/DKIM). اختبر: `pnpm mail:probe`.

## ٤. GitHub

| النوع | الاسم | القيمة |
|---|---|---|
| Secret | `SUPABASE_DB_URL_DIRECT` | رابط Supabase المباشر (5432) |
| Secret | `CODIQ_ENCRYPTION_KEY` | نفس قيمة سرّ الـWorker |
| Secret | `CLOUDFLARE_API_TOKEN` | توكن بصلاحيّات Workers Scripts + Containers + Account |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | معرّف الحساب |
| Secret | `CODIQ_BACKUP_ENCRYPTION_KEY` | مفتاح النسخ — **احفظ نسخة خارج GitHub**؛ بدونه لا استعادة |
| Secret | `CODIQ_BACKUP_S3_ENDPOINT` · `…_BUCKET` · `…_ACCESS_KEY_ID` · `…_SECRET_ACCESS_KEY` | حاوية R2 للنسخ |
| Variable | `CODIQ_PUBLIC_BASE_URL` | `https://example.com` — لفحص ما بعد النشر |
| Variable | `PG_MAJOR` | إصدار Postgres في Supabase (افتراضيّ `17`) |

- ضعها في **Environment** اسمه `production`، وفعّل عليه «Required reviewers» إن أردت موافقة يدويّة قبل كلّ نشر.
- **حماية الفروع:** `main` و`release` — طلب دمج إلزاميّ، و`ci / integration` فحص حاجب، ولا دفع قسريّ.
- **المسار:** دمج في `main` ← CI · دمج `main` في `release` ← CI ثمّ `deploy` تلقائياً (هجرات ← بناء الصورة ← نشر ← فحص `/api/ready`).
- **قالب:** Settings → General → ✓ *Template repository*.

## ٥. أوّل تشغيل

```bash
# من جهازك، مرّة واحدة، على قاعدة الإنتاج:
CODIQ_POSTGRES_URL_UNPOOLED="<direct url>" CODIQ_POSTGRES_URL="<direct url>" \
CODIQ_ENCRYPTION_KEY="<…>" SESSION_JWT_SECRET="<…>" NODE_ENV=production pnpm owner:create
```
ثمّ ادخل `/platform/dashboard`، فعّل المصادقة الثنائيّة، واضبط الخطط ووضع التسجيل.

## ٦. ما يجب معرفته عن التوسّع

- كلّ نسخة تشغّل عامل إشعارات خاصّاً بها؛ هذا آمن (المطالبة بالصفوف بـ`claimToken`) لكنّه يكرّر الاستعلامات. عند ٤ نسخ أو أكثر،
  اضبط `CODIQ_NOTIFICATIONS_WORKER=off` للنسخ الإضافيّة أو افصل العامل كخدمة.
- عدّاد الزيارات وحدّ معدّل نبضة الزيارة في ذاكرة كلّ نسخة — مقصود (تقريبيّ، ويُفرَّغ عند الإيقاف).
- حدود المعدّل الحسّاسة (الدخول، الشراء) في القاعدة ومشتركة بين النسخ.
- اتصالات القاعدة = عدد النسخ × `connection_limit`. راقبها مقابل حدّ خطّتك في Supabase.

## ٧. ما تحقّقتُ منه وما لم أتحقّق منه (2026-11-20)

| | |
|---|---|
| ✅ | الهجرات الـ84 والبحث والعزل على قاعدة بشكل Supabase (الإضافات في `extensions`) |
| ✅ | صورة Docker تُبنى وتعمل: `/api/health` و`/api/ready` و`/` تجيب 200، العامل يبدأ، الإيقاف نظيف |
| ✅ | الـWorker يجتاز فحص الأنواع و`wrangler deploy --dry-run` يحزمه (57 KB) |
| ✅ | واجهة `@cloudflare/containers@0.3.7` ومخطّط `wrangler@4.165.0` قُرئا من الحزم المنشورة نفسها |
| ⏳ | نشر حقيقيّ على Cloudflare وSupabase — يحتاج حساباتك وأسرارك |
| ⏳ | صورة `slim` (الإنتاجيّة) — بُنيت محلياً على `node:22-bookworm` لأنّ مرايا Debian محجوبة في بيئة الاختبار؛ على GitHub تعمل خطوة `apt` عادةً |
