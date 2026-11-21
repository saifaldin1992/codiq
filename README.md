# Codiq — قالب SaaS لمنصّات المتاجر متعدّدة المستأجرين

منصّة جاهزة لبيع **متاجر إلكترونية كخدمة**: التاجر يسجّل، يحصل على متجره بنطاقٍ فرعيّ،
يدير منتجاته وطلباته وفريقه ونقطة بيعه، والمنصّة تتقاضى اشتراكاً شهرياً وعمولة.
صُمّمت أوّلاً لسوق الدفع عند الاستلام في العراق، وتُستخدم هنا **قالباً** يُعاد تسميته ونشره.

> **الحالة:** 103 هجرة · 289 مساراً موثّقاً في `docs/openapi.json` · أكثر من 150 فحصاً واختباراً في CI.

---

## ما في الصندوق

| الطبقة | الموجود |
|---|---|
| **تعدّد المستأجرين** | عزل بنيويّ بمفاتيح خارجيّة مركّبة — الصفّ العابر بين المتاجر غير قابل للكتابة أصلاً |
| **الهويّات** | خمس هويّات منفصلة: مالك المنصّة · طاقم المنصّة · التاجر · طاقم المتجر · الزبون — جلسات مستقلّة، مصادقة ثنائيّة، صلاحيّات دقيقة |
| **SaaS** | تسجيل ذاتيّ بموافقة آليّة أو يدويّة · خطط وحصص يفرضها الخادم · تجربة مجانيّة · طلبات ترقية · إيقاف التاجر · أعلام ميزات · نوافذ صيانة وحوادث |
| **التجارة** | منتجات ومتغيّرات وتصنيفات · مخزون بحجوزات · طلبات بدورة حياة كاملة · سلّة وشراء كضيف · كوبونات · ولاء · تقييمات · مرتجعات · توصيل بالمحافظات · نقطة بيع تعمل بلا شبكة |
| **المال** | دفتر قيود · عمولات · تسويات · محفظة التاجر |
| **التشغيل** | صندوق صادر للإشعارات بعامل مستقلّ · نسخ احتياطيّ مُعمّى · Sentry · `/api/ready` · سجلّات تدقيق · حذف ناعم |

**التقنيات:** Node 22 · Express · Prisma · PostgreSQL 16+ · React 19 · Vite · Tailwind 4 · zod · أيّ تخزين متوافق مع S3.

## البدء محلياً

المتطلّبات: Node 22، pnpm 10، PostgreSQL 16+.

```bash
pnpm install
cp .env.example .env            # ثمّ املأ القيم — في التطوير تكفي قاعدة البيانات
pnpm phase1:db:migrate          # يطبّق الهجرات الـ93
pnpm owner:create               # ينشئ حساب مالك المنصّة (تفاعليّ، لا يقبل كلمة السرّ كوسيط)
pnpm demo:seed                  # اختياريّ: تاجر ومتجر ومنتجات تجريبيّة
pnpm build && node dist/index.js
```

ثمّ افتح `http://localhost:3000`. لوحة المالك: `/platform/dashboard` · لوحة التاجر: `/merchant/dashboard` · المتجر: `/store/<slug>`.

## الاختبارات

```bash
pnpm check && pnpm phase1:typecheck     # الأنواع
pnpm build                              # البناء
pnpm phase5:test                        # عزل المستأجرين — مثال على اختبار تكامل
pnpm review:fixes                       # تراجعيّات مراجعة 2026-11
```

اختبارات التكامل تحتاج قاعدة اسمها يحتوي `test` (حارسٌ يمنع تشغيلها على قاعدة حقيقيّة) والمتغيّرات
الواردة في رأس `.github/workflows/ci.yml`. بعض الاختبارات تحتاج `moto_server` (`pip install "moto[server,s3]"`).
القائمة الكاملة لما يشغّله CI في `.github/workflows/ci.yml`.

## استخدامه قالباً

1. **من GitHub:** «Use this template» (فعّل `Template repository` من إعدادات المستودع أوّلاً).
2. **أعد التسمية:**
   ```bash
   pnpm rebrand --name "اسمك" --domain example.com     # جرّب أوّلاً بـ --dry-run
   pnpm openapi:generate && pnpm check && pnpm brand:guard
   ```
   يغيّر اسم العرض والنطاق فقط، ولا يمسّ أسماء المتغيّرات (`CODIQ_*`) ولا الكعكات ولا رموز CSS —
   تغييرها يكسر النشر والنسخ الاحتياطيّة المخزّنة.
3. **السوق:** العملة (الدينار العراقيّ) والمحافظات وتطبيع أرقام الهاتف خاصّة بالعراق حالياً —
   انظر `phase1-backend/src/services/governorates.ts` و`docs/SAAS_READINESS_REVIEW.md`.
4. **انشر:** [`docs/DEPLOY_SUPABASE_CLOUDFLARE.md`](docs/DEPLOY_SUPABASE_CLOUDFLARE.md).

## بنية المستودع

```
client/             واجهة React (المتجر + لوحة التاجر + لوحة المالك)
phase1-backend/     الخادم: src/modules (الوحدات وسجلّها) · src/events (أحداث المجال) · src/http · src/services · src/auth · tests
server/             نقطة الدخول المركّبة: تخدم الواجهة و/api وتطلق عامل الإشعارات
prisma/             المخطّط والهجرات (مصدر الحقيقة للقاعدة؛ كثير من القيود موجود في SQL فقط)
shared/             ما تتقاسمه الواجهة والخادم
docs/               البنية · القرارات · التشغيل · الاسترداد · openapi.json
docs/history/       تقارير المراحل والتدقيقات السابقة (أرشيف)
```

## إضافة ميزة

المنصّة مقسّمة إلى وحدات: **مجلّد جديد في `phase1-backend/src/modules/` + سطر في `registry.ts`**، وتستطيع الاستماع إلى أحداث
المنصّة (طلب جديد، تغيّر حالة، تاجر جديد…) دون لمس شيفرتها. الدليل الكامل: [`phase1-backend/src/modules/README.md`](phase1-backend/src/modules/README.md).

## وثائق يجب قراءتها قبل التعديل

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — الآليّات الحاملة، ولماذا ترتيب الوسائط مهمّ.
- [`docs/PROJECT_ENGINEERING_PRINCIPLES.md`](docs/PROJECT_ENGINEERING_PRINCIPLES.md) — قواعد ملزمة.
- [`docs/GUARDS_AND_RATCHETS.md`](docs/GUARDS_AND_RATCHETS.md) — الحرّاس في CI وما يحميه كلٌّ منها.
- [`docs/DECISIONS_LEDGER.md`](docs/DECISIONS_LEDGER.md) — كلّ قرار بمعرّفه (ق-NNN) وسببه.
- [`docs/SAAS_READINESS_REVIEW.md`](docs/SAAS_READINESS_REVIEW.md) — المراجعة الشاملة وما بقي.

## الترخيص

MIT.
