# بوابة المرحلة 10 — تنظيف `package.json`

**الحالة:** قرار مالك المشروع مطلوب قبل حذف أي حزمة أو تعديل إعدادات البناء.

## منهج التدقيق

تم البحث في كود التشغيل وملفات البناء فقط: `client/src/` و`phase1-backend/` و`server/` و`shared/` و`vite.config.ts` و`client/index.css`. لم تُعد النصوص التاريخية في `docs/` و`reports/` و`template.json` دليلاً على استيراد فعلي.

## حزم طلبت مراجعتها وكانت غائبة مسبقاً

| الحزمة | الحالة الفعلية في `package.json` | الإجراء |
|---|---|---|
| `drizzle-orm` | غير مدرجة. | لا حذف مطلوب. |
| `drizzle-kit` | غير مدرجة. | لا حذف مطلوب. |
| `mysql2` | غير مدرجة. | لا حذف مطلوب. |

## قائمة الحذف المقترحة

| الحزمة | القسم الحالي | دليل عدم الاستيراد الفعلي | التغيير المصاحب المطلوب |
|---|---|---|---|
| `axios` | dependencies | لا `import` أو `require` في كود التشغيل أو البناء. | حذف من manifest وlockfile. |
| `@hookform/resolvers` | dependencies | لا `import` أو `require` في كود التشغيل أو البناء. | حذف من manifest وlockfile. |
| `framer-motion` | dependencies | لا `import` أو `require` في كود التشغيل أو البناء. | حذف من manifest وlockfile. |
| `nanoid` | dependencies | لا `import` أو `require` في كود التشغيل أو البناء. | حذف من manifest وlockfile. |
| `tailwindcss-animate` | dependencies | لا `import` أو `require` في كود التشغيل أو البناء. | حذف من manifest وlockfile. |
| `@tailwindcss/typography` | devDependencies | لا `import` أو `require` في كود التشغيل أو البناء. | حذف من manifest وlockfile. |
| `add` | devDependencies | لا `import` أو `require` في كود التشغيل أو البناء؛ ظهور كلمة `add` في واجهات المنتجات ليس استيراداً للحزمة. | حذف من manifest وlockfile. |
| `autoprefixer` | devDependencies | لا `import` أو `require` ولا ملف PostCSS فعلي يستخدمه. | حذف من manifest وlockfile. |
| `postcss` | devDependencies | لا `import` أو `require` ولا ملف PostCSS فعلي يستخدمه. | حذف من manifest وlockfile. |
| `pnpm` | devDependencies | مدير الحزم محدد عبر `packageManager` ولا يستورد كحزمة تطبيق. | حذف من manifest وlockfile؛ تبقى قيمة `packageManager`. |
| `vite-plugin-manus-runtime` | devDependencies | مستورد حصراً من `vite.config.ts`، ولا يوجد استيراد تشغيلي آخر. | حذف الاستيراد والاستدعاء من `vite.config.ts` ثم حذف الحزمة. |
| `@builder.io/vite-plugin-jsx-loc` | devDependencies | مستورد حصراً من `vite.config.ts`، ولا يوجد استيراد تشغيلي آخر. | حذف الاستيراد والاستدعاء من `vite.config.ts` ثم حذف الحزمة. |

## الحزم التي يجب إبقاؤها

| الحزمة | الدليل |
|---|---|
| `@aws-sdk/client-s3` | مستوردة في `phase1-backend/src/services/product-image-storage.service.ts` واختبارات صور المنتجات. |
| `next-themes` | مستوردة في `client/src/components/ui/sonner.tsx`. |
| `tw-animate-css` | مستوردة من `client/src/index.css`. |
| بقية حزم React/Express/Prisma/pg/Vite/Tailwind وواجهات Radix | لها استيرادات أو تُستخدم مباشرة في أوامر البناء والتشغيل والاختبارات. |

## تحذير pnpm وخطة إصلاحه

أظهر التشغيل الفعلي تحذيراً بأن حقل `pnpm` داخل `package.json` لم يعد مقروءاً لـ`patchedDependencies` و`overrides`. التعديل المقترح هو نقل هذين المفتاحين، بالقيم نفسها، إلى `pnpm-workspace.yaml`، وحذف الكتلة `pnpm` من `package.json`. لا يُنقل أي سر ولا يتغير أي اعتماد وظيفي.

## القرار المطلوب

> هل توافق على تنفيذ قائمة الحذف أعلاه، وحذف إضافتي Vite المقيدتين من `vite.config.ts`، ونقل إعدادات pnpm كما هو موضح؟
