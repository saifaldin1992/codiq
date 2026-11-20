# الوحدات (Modules) — كيف تضيف ميزة

المنصّة مقسّمة إلى **وحدات**. كلّ وحدة مجال واحد: مساراتها، وخدماتها، ومخطّطاتها، وما تستمع إليه من أحداث.
إضافة ميزة = **مجلّد جديد + سطر واحد في السجلّ**. لا تعديل في `http/app.ts` ولا في شيفرة ميزةٍ أخرى.

```
src/
├── modules/
│   ├── platform-module.ts   ← العقد: { id, domain, title, register, subscribe? }
│   ├── core-modules.ts      ← الوحدات الأساسيّة الـ28 (ملفّات http/routes القائمة) بترتيبها الأصليّ — لا تُعِد ترتيبها
│   ├── registry.ts          ← السجلّ: الأساسيّة ثمّ الإضافات — هنا تضيف وحدتك
│   └── <your-module>/       ← وحدتك
│       ├── index.ts         ← defineModule({...})
│       ├── routes.ts        ← المسارات
│       ├── schema.ts        ← مخطّطات zod (اختياريّ)
│       └── service.ts       ← المنطق
└── events/domain-events.ts  ← الأحداث التي تستطيع الاستماع إليها
```

مثالٌ حقيقيّ يعمل: [`platform-modules/`](./platform-modules/) — شاشة «الوحدات» في لوحة المالك.

---

## ١. الوحدة

```ts
// src/modules/order-webhooks/index.ts
import { defineModule } from "../platform-module.js";
import { registerOrderWebhookRoutes } from "./routes.js";
import { notifyMerchantEndpoint } from "./service.js";

export const orderWebhooksModule = defineModule({
  id: "order-webhooks",             // kebab-case = اسم المجلّد
  domain: "orders",
  title: "إرسال الطلبات الجديدة إلى رابط التاجر",
  register: registerOrderWebhookRoutes,
  subscribe(bus) {
    bus.on("order.created", "order-webhooks", (event) => notifyMerchantEndpoint(event));
  },
});
```

ثمّ في `registry.ts`:

```ts
export const EXTENSION_MODULES = [
  platformModulesModule,
  orderWebhooksModule,   // ← سطرٌ واحد
];
```

## ٢. المسارات — نفس قواعد الأساس، بلا استثناء

```ts
// src/modules/order-webhooks/routes.ts
export function registerOrderWebhookRoutes(app: Express) {
  app.put("/merchant/stores/:storeSlug/order-webhook", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);                                  // CSRF — csrf:guard يفرضه
    const { store } = await requireStoreActor(request, "settings.manage"); // الهويّة والصلاحيّة
    const input = parseOrThrow(orderWebhookSchema, request.body ?? {});   // zod — validation:guard يفرضه
    response.status(200).json({ webhook: await saveWebhook(store.id, input) });
  }));
}
```

**كلّ حارس في CI يفحص `modules/*/routes.ts` كما يفحص `http/routes/`** (عبر `phase1-backend/source-layout.mjs`):
التحقّق بـzod · فحص المصدر للكتابة · مغلّف القوائم المرقّمة · سياسة التخزين المؤقّت · سجلّ القدرات ·
وصول الشاشات (surface) · وثيقة OpenAPI. وحدةٌ جديدة لا تستطيع تجاوز القواعد بمجرّد أنّها في مكانٍ جديد.

وبعد إضافة مسار: `pnpm openapi:generate` (الوثيقة مولَّدة، والحارس يرفض الانحراف).

**الترتيب:** وحداتك تُركَّب **بعد** الأساس. `module-registry.unit.mjs` يرفض وحدةً تسجّل مساراً يسجّله الأساس.

## ٣. الأحداث — تتفاعل مع ميزةٍ أخرى دون أن تلمسها

| الحدث | متى |
|---|---|
| `order.created` | طلب جديد من المتجر أو كضيف (الإعادة المتطابقة لا تُطلقه) |
| `order.pos_sale_recorded` | بيعٌ عند الكاشير |
| `order.status_changed` | أيّ انتقال في حالة الطلب |
| `merchant.registered` | تاجرٌ جديد (تسجيل ذاتيّ أو يدويّ) |
| `customer.registered` | زبونٌ جديد في متجر |
| `settlement.created` | تسويةٌ حُوِّل مالها |
| `plan.version_published` | إصدارٌ جديد لخطّة |

**الضمانات** (يثبتها `events:test`):
- يُطلَق **بعد الإيداع** فقط — معالجك لا يرى أبداً كتابةً تراجعت.
- **معزول** — معالجٌ يرمي خطأً يُسجَّل ولا يُسقط الطلب الذي أطلقه ولا يوقف المعالجين الآخرين.
- **مرّة واحدة** لكلّ عمليّة، مهما بُني التطبيق.

**حدّه:** المعالج يعمل **داخل العمليّة وبأفضل جهد**. إن مات الخادم بين الإيداع والمعالج ضاع ذلك النداء.
فإن كان الأثر **واجباً** (رسالة لزبون، مال) فاكتبه في **صندوق الصادر** داخل المعاملة نفسها — لا في حدث.
الأحداث للتكاملات والتحليلات وروابط التجّار والذاكرة المؤقّتة.

لإضافة حدث جديد: عرّفه في `DomainEventMap`، وأطلقه بـ`domainEvents.emit(...)` **بعد** `await prisma.$transaction(...)` لا داخلها.

## ٤. الشاشة

- **لوحة التاجر:** أضف السطر في `client/src/dashboard/merchant-screens.tsx` وعنصر القائمة في `client/src/config/navigation.ts`.
  `screens:guard` يرفض عنصر قائمة «implemented» بلا شاشة.
- **لوحة المالك:** في `OwnerDashboard.tsx` (لم تُحوَّل بعد إلى جدول) + `ownerNavGroups`.

## ٥. الاختبارات

ضع اختبار وحدتك في `phase1-backend/tests/<id>.integration.mjs`، وأضِف سكربته في `package.json` وخطوته في `.github/workflows/ci.yml`.
اتبع نمط `domain-events.integration.mjs`: قاعدة اسمها يحتوي `test`، وحارس `assertSafeTestDatabaseUrl`.

## ٦. ما لا تفعله

- لا تُعِد ترتيب `core-modules.ts` — ترتيب Express سلوك.
- لا تستورد خدمات وحدةٍ أخرى لتستدعيها عند حدثٍ يخصّها — استمع إلى الحدث.
- لا تُطلق حدثاً داخل معاملة.
- لا تضع بيانات شخصيّة في حمولة حدث.
