# سجلّ الدفعة ٢ — مسارات المال

قائمة الفحص في [README.md](README.md). كلّ ملفّ يُقرأ كاملاً؛ سطره هنا يُحدَّث عند الانتهاء منه.

| الملفّ | الأسطر | قُرئ في | النتائج |
|---|---|---|---|
| `phase1-backend/src/services/storefront.service.ts` | 2,575 | 2026-11-22 (الأسطر ١–٢٦٣٠ كاملة) | م-١، م-٢، ت-١…ت-٦، ر-١…ر-٧ |
| `phase1-backend/src/services/order-lifecycle.service.ts` | 715 | — | لم يُقرأ |
| `phase1-backend/src/services/loyalty.service.ts` | 622 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-payments/payments.service.ts` | 614 | — | لم يُقرأ |
| `phase1-backend/src/services/finance.service.ts` | 608 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-cart/checkout.service.ts` | 596 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-rewards/rewards.service.ts` | 489 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-cart/cart.service.ts` | 460 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-partner/partner.service.ts` | 459 | — | لم يُقرأ |
| `phase1-backend/src/services/coupon.service.ts` | 445 | — | لم يُقرأ |
| `phase1-backend/src/services/payment-methods.service.ts` | 282 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-rewards.service.ts` | 222 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-payments/providers.ts` | 221 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-cart/routes.ts` | 195 | — | لم يُقرأ |
| `phase1-backend/src/services/guest-checkout.service.ts` | 183 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-wallet.service.ts` | 170 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-rewards/routes.ts` | 134 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-partner/routes.ts` | 97 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-payments/routes.ts` | 76 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-cart/schema.ts` | 53 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-rewards/schema.ts` | 38 | — | لم يُقرأ |
| `phase1-backend/src/services/live-price.ts` | 30 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-payments/schema.ts` | 20 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-payments/index.ts` | 13 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-rewards/index.ts` | 9 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-partner/index.ts` | 9 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-cart/index.ts` | 9 | — | لم يُقرأ |
| `phase1-backend/src/modules/market-partner/schema.ts` | 7 | — | لم يُقرأ |

## النتائج

(تُضاف بالترتيب الذي تُكتشف به: ح = حرج، م = مهمّ، ت = تحسين، ر = ترتيب)

**لا نتيجة حرجة حتى الآن.** ما يحرس المال في `checkout` صحيح: السعر والمخزون يُقرآن تحت قفل واحد، والسعر المتغيّر يرفض الطلب
ويصحّح السلّة، والكوبون مرّة لكلّ طلب بقيد في القاعدة، والمخزون يُحجز في المعاملة نفسها، والسلّة تتحوّل فقط إن لم تتغيّر
نسختها، وإكمال الطلب يُنقص المخزون ذرّيّاً.

### [م-١] رسائل خطأ إنجليزيّة تصل متسوّق السوق — مهمّ
- المكان: ٧٩ رسالة في `storefront.service.ts` (٣٩ من ٥٢)، و`order-lifecycle.service.ts` (١٣ من ١٥)، و`finance.service.ts` (٣ من ١٣)،
  و`coupon.service.ts` (٢٤ من ٢٤). مثال: `CART_VERSION_CONFLICT` ← «The cart was changed by another request.»
- ما يحدث: واجهة **المتجر** تترجم الرمز إلى العربيّة بجدول في `client/src/lib/storefront-api.ts` (`errorMessage`)، فزبون المتجر لا يرى
  الإنجليزيّة. واجهة **السوق** لا جدول لها: تعرض نصّ الخادم كما هو (`setFailure(error.message)`)، فيقرأ متسوّق السوق الإنجليزيّة.
- الحالة: قيد التحديد بعد قراءة باقي ملفّات الدفعة.

### [م-٢] بطاقة المنتج في المتجر تعرض السعر قبل «عرض الساعة» — مهمّ
- المكان: `client/src/components/ProductCard.tsx`، الدالّة `priceLabel`.
- ما يحدث: حين تتساوى أسعار المتغيّرات (منتج بمتغيّر واحد مثلاً) تعرض `product.priceIqd` — السعر **المخزّن** — لا `minPriceIqd` الحيّ.
  أثناء عرض ساعة بسعر ٨٠٬٠٠٠ لمنتج سعره ١٠٠٬٠٠٠، تقول البطاقة ١٠٠٬٠٠٠ ويدفع الزبون ٨٠٬٠٠٠: لا يرى العرض.
- الحالة: **مُصلَح** — `6c0165f` (والنقل الحرفيّ قبله `8a1dcff`). الاختبار `price-label.unit.mjs`: قبل «actual ١٠٠٬٠٠٠، expected ٨٠٬٠٠٠»، بعد نجح.

### [ت-١] قراءة صفّ المتجر ثلاث مرّات في معاملة الشراء — تحسين
- المكان: `checkout` الأسطر ١٥٧٠ (الحالة) و١٦٣٦ (المالك) و١٦٧٩ (الاستلام). قراءة واحدة تكفي.
- الحالة: **مُصلَح** — `66421a3`: قراءة واحدة للمتجر.

### [ت-٢] قراءة صفّ الزبون مرّتين في المعاملة نفسها — تحسين
- المكان: الأسطر ١٩٧٧ و٢٠٠٥.
- الحالة: **مُصلَح** — `66421a3`: قراءة واحدة للزبون.

### [ت-٣] حدود المعدّل في ملفّ متجر الزبون — تحسين (تقسيم)
- المكان: `consumeStorefrontRateLimit` و`refundStorefrontRateLimit` — تستعملهما المنصّة كلّها، مكانهما ملفّ مستقلّ.
- الحالة: **مُنجَز** — الملفّ (٢٦٥٠ سطراً) قُسّم بحسب الوظيفة إلى `services/storefront/`: `shared` و`rate-limit` و`catalog` و`cart` و`addresses` و`checkout` و`orders`. نقلٌ حرفيّ: الجمل العليا الـ٧٤ كلّها موجودة بنصّها في الملفّات الجديدة (أُثبت آليّاً)؛ التغيير الوحيد كلمة `export` على ١٤ اسماً داخليّاً صارت تُستعمل بين الملفّات. الاستيرادات حُسبت من جدول رموز المترجم. `storefront.service.ts` صار يعيد تصدير الأسماء العامّة نفسها فلم يتغيّر أيّ مستورِد.
- الحواجز التي كانت تقرأ الملفّ باسمه أُشير بها إلى مكانه الجديد: `deleted-leak-guard` (مفاتيح الدوالّ)، `order-money` (معادلة المجموع في `checkout.ts`)، `keyset-index.map.json`، تسميات `perf-index-evidence` (صارت باسم الدالّة لا رقم سطر قديم)، و`serializable-retry.unit` صار يفحص `services/` تكراريّاً فلا يفوته المجلّد الجديد.
- القياس: الأسطر الطويلة ١٢ ← ١٢، الأسطر الزائدة عن حدّ الملفّ ٢١٧٥ ← ٨٢٤، الدوالّ الطويلة ١٢ ← ١١، المكرّر ٧٥ ← ٢٥ سطراً. عدد الملفّات الكبيرة ١١٣ ← ١١٥ لأنّ الدَّين توزّع على ثلاثة ملفّات (`cart` و`catalog` و`checkout`) — يُعالج حين تُقسّم دوالّها الطويلة. سُجّل بخيار جديد `code-shape --write --split <file>` لا يقبل إلّا أن يكون مجموع كلّ مقياس في الملفّات الجديدة ≤ قيمة الملفّ القديم.

### [ت-٤] `cartPayload(cart: any)` — تحسين
- يُفقد فحص الأنواع على شكل السلّة.
- الحالة: **مُصلَح** — `cartPayload` يأخذ نوع Prisma المشتقّ من `CART_WITH_ITEMS` نفسه، و`expireGuestCartIfNeeded` يأخذ النوع نفسه (أو `null`) ويُرجعه، بعد أن كان يُرجع `any` فيُفقد نوع سلّة الضيف في كلّ ما بعده. الدليل: تحريف `cart.items` إلى `cart.itmes` كان يمرّ صامتاً، وصار المترجم يرفضه (TS2551). لا تغيير في السلوك: كلّ النداءات تمرّ بـ`CART_WITH_ITEMS` (يتحقّق المترجم من ذلك الآن)، فحذف `?? []` لا يغيّر شيئاً.

### [ت-٥ ← م-٣] إضافات متزامنة للمنتج نفسه تضيع — رُفع إلى مهمّ بعد إعادة إنتاجه
- المكان: `addCartItem` (يقرأ الكمّيّة ثمّ يكتب المجموع). لا خطر ماليّ — `checkout` يعيد التحقّق تحت قفل — لكنّ زيادة ذرّيّة أصحّ.
- الحالة: **مُصلَح** — `79407d4`. أُعيد إنتاجه ثلاث مرّات من ثلاث: عشر إضافات متزامنة صارت ٣ و٣ و٢ قطع. الإصلاح: `upsert` بزيادة ذرّيّة. الاختبار `cd1` المشهد 10a′ نجح ثلاث مرّات من ثلاث.

### [ت-٦] «أعد الطلب» لا يطبّق حدّ الطلب الواحد — تحسين
- المكان: `reorderIntoCart`. «أضف للسلّة» يطبّقه منذ م٢؛ إعادة الطلب تُدخل ٥ قطع من منتج حدّه ٢ فتُرفض عند الإتمام فقط.
- الحالة: **مُصلَح** — `10b9f4f`. الاختبار `cd1` المشهد 10a: قبل «actual []»، بعد نجح.

### [ر-١] تعليق `CartPriceMoved` فوق واجهة أخرى — ترتيب
- الأسطر ١٤٢٧–١٤٣٩ فوق `RefusedCartLine` بدل فوق صنفه في السطر ١٤٧٠.
- الحالة: **مُصلَح** — `3765695` (تعليقات فقط، شجرة الصياغة متطابقة).

### [ر-٢] حالة الدفع بشرط ثلاثيّ متداخل خمس مستويات — ترتيب
- الأسطر ٢٠٤٤–٢٠٥٣. جدول صغير أوضح وأسهل للإضافة.
- الحالة: **مُصلَح** — `d99ac7a`: `initialPaymentStatus` وجدول صغير.

### [ر-٣] تعليق `marketPayment` على سطر الحقل نفسه — ترتيب
- السطر ٦٧ (من م١٣).
- الحالة: **مُصلَح** — `3765695`.

### [ر-٤] تعليق مكرّر فوق `refundStorefrontRateLimit` — ترتيب
- الأسطر ٢٩٢–٣٠٣: فقرتان تبدآن بالجملة نفسها.
- الحالة: **مُصلَح** — `3765695`.

### [ر-٥] تعريف ما تُحمَّل به عناصر السلّة منسوخ عشر مرّات — ترتيب (تكرار)
- الأسطر ٣٨٩، ٤٠٤، ٤٢٨، ٤٥٣، ٩١٣، ٩٩٢، ١٠٥٦، ١١٤٣، ٢٤٥٦، ٢٤٧٥. ثلاث نسخ بلا ترتيب العناصر بـ`createdAt` — وواحدة منها (١٠٥٦)
  تُرجع سلّة لها عناصر فعلاً، فيصل ترتيبها مختلفاً. يُوحَّد في ثابت واحد.
- الحالة: **مُصلَح** — `8022294`: ثابت واحد `CART_WITH_ITEMS`.

### [ر-٦] اسم المعامل `createGuest` يضلّل — ترتيب
- السطر ٤٠١: ينشئ سلّة **زبون** أيضاً. الاسم الصحيح `createIfMissing`.
- الحالة: **مُصلَح** — `f5ac221`.

### [ر-٧] تعليق `deliveryRateForGovernorate` فوق دالّة أخرى — ترتيب
- الأسطر ١٢٩٩–١٣٠٨ فوق `publicDeliveryAreas` (فوق تعليقها هي)، والدالّة التي يصفها في السطر ١٣٣٧.
- الحالة: **مُصلَح** — `3765695`.
