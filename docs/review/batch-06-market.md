# سجلّ الدفعة ٦ — وحدات السوق

قائمة الفحص في [README.md](README.md). كلّ ملفّ يُقرأ كاملاً؛ سطره هنا يُحدَّث عند الانتهاء منه.
النطاق (الخطّة §٣، الدفعة ٦): وحدات السوق في `phase1-backend/src/modules/` التي لم تُقرأ في الدفعات ٢–٥، والسجلّ والوحدات الأساسيّة. 63 ملفّاً، 10,575 سطراً.
خارج النطاق لأنّه قُرئ: ما تقسّم من ملفّات قُرئت في الدفعة ٢ قبل تقسيمها (`payments/` و`checkout/` و`rewards/` و`cart/` و`partner/` — 20 ملفّاً)، و`market-account` (الدفعة ٣).

| الملفّ | الأسطر | قُرئ في | النتائج |
|---|---|---|---|
| `phase1-backend/src/modules/market-wheel/wheel.service.ts` | 652 | 2026-11-28 (كاملاً) | ت-١، ت-٢ (قُسّم). اللفّة تقفل المتسوّق، والمخزون يُنقص بتحديث مشروط، والاستلام يقفل الجائزة ويفحص حالتها ومدّتها |
| `phase1-backend/src/modules/market-orders/after-sales.service.ts` | 587 | 2026-11-28 (كاملاً) | ت-٣، ت-٤ (قُسّم). الطلب يُقرأ بملكيّة المتسوّق؛ التقييم بعد الاستلام وفي نافذته، ولمنتجات الطلب وحدها؛ الانتقالات بفحص النسخة. ملاحظة: سبب الإلغاء يُكتب بعد الإلغاء في خطوة مستقلّة |
| `phase1-backend/src/modules/market-campaigns/campaigns.service.ts` | 529 | 2026-11-28 (كاملاً) | ت-٥، ت-٦ (قُسّم). الساعات داخل مدّة الحملة وبلا تداخل؛ لا شيء يتحرّك بعد بدء الساعة؛ الاقتراح لمنتج المتجر وحده وبالحدّ الأدنى للخصم |
| `phase1-backend/src/modules/market-support/tickets.service.ts` | 524 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/directory.service.ts` | 505 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-home/content.service.ts` | 480 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-reels/reels.service.ts` | 390 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/products.service.ts` | 376 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-support/routes.ts` | 358 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-help/help.service.ts` | 343 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-home/routes.ts` | 339 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-help/routes.ts` | 330 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/profile.service.ts` | 266 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/routes.ts` | 262 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-reels/routes.ts` | 255 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-home/home.service.ts` | 250 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/presentation.ts` | 219 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-home/schema.ts` | 212 | — | لم يُقرأ |
| `phase1-backend/src/modules/core-modules.ts` | 212 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-help/favourites.service.ts` | 205 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/merchant.service.ts` | 204 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-wheel/routes.ts` | 199 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-help/inbox.service.ts` | 196 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-visual/visual.service.ts` | 187 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/market-score.ts` | 183 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-campaigns/routes.ts` | 183 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/moderation.service.ts` | 173 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/metrics.service.ts` | 160 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/schema.ts` | 155 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-orders/routes.ts` | 151 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/map-tiles.service.ts` | 147 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/routes.ts` | 145 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/schema.ts` | 130 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/categories.service.ts` | 121 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-visual/routes.ts` | 98 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-help/schema.ts` | 97 | — | لم يُقرأ |
| `phase1-backend/src/modules/registry.ts` | 78 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-campaigns/schema.ts` | 67 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/stats.service.ts` | 64 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-wheel/schema.ts` | 61 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/search.service.ts` | 61 | — | لم يُقرأ |
| `phase1-backend/src/modules/platform-module.ts` | 55 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-orders/reasons.ts` | 53 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-orders/schema.ts` | 48 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-geo/service.ts` | 32 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-support/schema.ts` | 29 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-reels/schema.ts` | 26 | — | لم يُقرأ |
| `phase1-backend/src/modules/platform-modules/routes.ts` | 20 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-geo/routes.ts` | 17 | — | لم يُقرأ |
| `phase1-backend/src/modules/platform-modules/service.ts` | 16 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-wheel/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-visual/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-support/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-stores/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-reels/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-orders/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-home/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-help/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-geo/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-catalog/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-campaigns/index.ts` | 10 | — | لم يُقرأ |
| `phase1-backend/src/modules/platform-modules/index.ts` | 9 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-visual/schema.ts` | 6 | — | لم يُقرأ |

## النتائج

(تُضاف بالترتيب الذي تُكتشف به: ح = حرج، م = مهمّ، ت = تحسين، ر = ترتيب)

### [ت-١] جائزة العجلة تُلغى مرّتين، أو تُلغى بعد استلامها — تحسين
- المكان: `setWinStatus` (لوحة المالك). الحالة تُقرأ خارج المعاملة ثمّ تُكتب بالمعرّف وحده: إلغاءان معاً يمرّان فتعود الوحدة إلى مخزون الجائزة مرّتين؛ وإلغاءٌ يسابق استلام المتسوّق قد يكتب «ملغاة» فوق «مستلَمة» — يبقى له الكوبون أو النقاط، والوحدة تُباع ثانيةً.
- الحالة: **مُصلَح** — النقل يُحجز على الحالة التي قُرئت (`updateMany` مشروط)؛ الخاسر ٤٠٩ `WIN_STATUS_CHANGED`. الاختبار (`market:wheel`): ثلاثة إلغاءات معاً — نجح اثنان والمخزون عاد مرّتين قبل (ثلاث مرّات)؛ واحد بعد، واستلامٌ وإلغاءٌ معاً لا يقفان كلاهما (خمس مرّات).

### [ت-٢] تقسيم خدمة العجلة — تحسين
- `wheel.service.ts` (٦٥٢ سطراً) ← `market-wheel/wheel/{play,wins,owner}.ts`، نقلٌ حرفيّ (٣٤ جملة كلّها) قبل إصلاح ت-١ (الملفّ فوق الحدّ ولا ينمو).

### [ت-٣] رمز الاستلام يُخمَّن بطلبات متوازية — تحسين
- المكان: `confirmHandover` (المتجر). قفل «خمس محاولات خاطئة» كان يُفحص قبل المقارنة ويُعدّ بعدها: تخمينات متوازية تقرأ كلّها «٠ فشل» فتُقارَن كلّها — الرمز من أربعة أرقام (١٠٬٠٠٠ احتمال) يُكسر بدفعة طلبات، فيُعلَّم الطلب «سُلِّم برمز الاستلام» دون الزبون.
- الحالة: **مُصلَح** — كلّ تخمين يحجز محاولته أوّلاً بتحديث مشروط (`failures < 5`)، ثمّ يُقارن؛ ما زاد يُرفض بـ٤٢٩ دون قراءة. الرمز الصحيح لا يستهلك محاولة. الاختبار (`market:orders`): ٣٠ تخميناً متوازياً — قورن ٦ ثمّ ١٠ قبل؛ ≤ ٥ بعد (ثلاث مرّات)، واختبارات القفل والاستلام القائمة تمرّ.

### [ت-٤] تقسيم خدمة ما بعد البيع — تحسين
- `after-sales.service.ts` (٥٨٧ سطراً) ← `market-orders/after-sales/{shopper,state,store}.ts`، نقلٌ حرفيّ (٢٦ جملة كلّها) قبل إصلاح ت-٣.

### [ت-٥] عرضٌ سحبه المتجر يُعتمد رغم ذلك — تحسين
- المكان: `decideDeal` و`withdrawDeal`. القراءة خارج أيّ معاملة والكتابة بالمعرّف وحده: اعتمادٌ يسابق سحب المتجر قد يكتب «معتمد» فوق «مسحوب» — فيُعرض خصم المتجر في ساعة انسحب منها.
- الحالة: **مُصلَح** — القرار والسحب كلاهما مشروط بالحالة التي قُرئت؛ الخاسر ٤٠٩ `DEAL_CHANGED`. (اعتمادٌ ثمّ سحب قبل بدء الساعة مشروع ويبقى.) الاختبار (`market:campaigns`، ٢٠ جولة): السحب ٢٠٠ والعرض ينتهي «معتمداً» قبل (ثلاث مرّات على الكود القديم)؛ لا يحدث بعد (ثلاث مرّات).

### [ت-٦] تقسيم خدمة الحملات — تحسين
- `campaigns.service.ts` (٥٢٩ سطراً) ← `market-campaigns/campaigns/{owner,deals,pages}.ts`، نقلٌ حرفيّ (٢٠ جملة كلّها) قبل إصلاح ت-٥.

### ملاحظات

