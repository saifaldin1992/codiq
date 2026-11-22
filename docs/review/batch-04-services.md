# سجلّ الدفعة ٤ — باقي خدمات الخادم

قائمة الفحص في [README.md](README.md). كلّ ملفّ يُقرأ كاملاً؛ سطره هنا يُحدَّث عند الانتهاء منه.
النطاق (الخطّة §٣): خدمات `phase1-backend/src/services/` التي لم تُقرأ في الدفعتين ٢ و٣ — 68 ملفّاً، 20,224 سطراً.
المهامّ المجدولة (`retention-job`، `reservation-expiry-job`، `purge-job`، `retention`) و`config.service` للدفعة ٥ كما في الخطّة.
الترتيب: ما يمسّ المال والصلاحيّات أوّلاً.

| الملفّ | الأسطر | قُرئ في | النتائج |
|---|---|---|---|
| `phase1-backend/src/services/pos.service.ts` | 669 | 2026-11-22 (كاملاً) | لا نتيجة (ملاحظة) |
| `phase1-backend/src/services/entitlement.service.ts` | 1,028 | 2026-11-22 (كاملاً) | ت-١، ت-٢ (قُسّم)، ت-٣ |
| `phase1-backend/src/services/return-request.service.ts` | 285 | 2026-11-22 (كاملاً) | ملاحظتان |
| `phase1-backend/src/services/return-inspection.service.ts` | 342 | 2026-11-22 (كاملاً) | لا نتيجة |
| `phase1-backend/src/services/order-self-cancel.service.ts` | 108 | 2026-11-22 (كاملاً) | لا نتيجة |
| `phase1-backend/src/services/order-bulk.service.ts` | 173 | 2026-11-22 (كاملاً) | لا نتيجة |
| `phase1-backend/src/services/platform-staff.service.ts` | 335 | 2026-11-22 (كاملاً) | الفريق للمالك وحده (لا رمز صلاحيّة يمنحه)؛ تغيير الدور أو التعطيل أو الإزالة يُبطل الجلسات في المعاملة نفسها؛ الدخول بـ٤٠١ واحد وزمن ثابت. ملاحظة أدناه |
| `phase1-backend/src/services/staff.service.ts` | 310 | 2026-11-22 (كاملاً) | م-١ |
| `phase1-backend/src/services/registration.service.ts` | 318 | 2026-11-22 (كاملاً) | لا نتيجة (ملاحظة) |
| `phase1-backend/src/services/manual-provisioning.service.ts` | 223 | 2026-11-22 (كاملاً) | التاجر اليدويّ: كلمة مؤقّتة تُفرض تغييراً، الهاتف يُفحص، وسجلّ تدقيق في المعاملة. الزبون اليدويّ: صفّ ضيف بلا كلمة مرور ورقم موحّد |
| `phase1-backend/src/services/merchant-suspension.service.ts` | 185 | 2026-11-22 (كاملاً) | الإيقاف يُغلق الحساب والمتاجر وجلسات التاجر وموظّفيه في معاملة واحدة مع سجلّ التدقيق؛ لا يمسّ الطلبات ولا الدفاتر. الاستئناف يعيد كلّ المتاجر — ولا كاتب آخر لـ`isActive` غير التسجيل، فلا متجر يُفتح بغير حقّ |
| `phase1-backend/src/services/csv-transfer.service.ts` | 895 | 2026-11-22 (كاملاً) | التصدير محميّ من حقن الصيغ. الاستيراد: تحقّق كامل قبل أيّ كتابة، رموز SKU تُفحص داخل الملفّ وضدّ المتجر (الحيّ فقط)، مسارات التصنيف تبدأ من الجذر، والإدخال معاملة واحدة كلّها أو لا شيء. ملاحظة أدناه |
| `phase1-backend/src/services/csv.ts` | 119 | 2026-11-22 (كاملاً) | لا نتيجة |
| `phase1-backend/src/services/availability.service.ts` | 1,066 | 2026-11-22 (كاملاً) | الأسبقيّة دالّة نقيّة مختبرة؛ كلّ تغيير للمنصّة يُسجَّل في التدقيق؛ واجهة المتسوّق تقرأ الحالة الفعليّة (الساعة والنوافذ) لا العمود. ملاحظة أدناه |
| `phase1-backend/src/services/maintenance.service.ts` | 760 | — | لم يُقرأ |
| `phase1-backend/src/services/delivery-rates.service.ts` | 104 | — | لم يُقرأ |
| `phase1-backend/src/services/delivery.service.ts` | 471 | 2026-11-22 (كاملاً) | م-٢. التحديث بالنسخة، ومقيّد بالمتجر؛ الكشف والمطابقة على نافذة محدودة وبصفحات |
| `phase1-backend/src/services/soft-delete/soft-delete.service.ts` | 1,348 | 2026-11-22 (كاملاً) | الحذف والاستعادة وسلّة المحذوفات: كلّها مقيّدة بالمتجر ومقفلة؛ حدّ الخطّة داخل المعاملة (ت-٤ يجعله يصمد تحت التزامن) |
| `phase1-backend/src/services/product-catalog.service.ts` | 1,177 | 2026-11-22 (كاملاً) | ت-٤ (حدّ المنتجات). التصنيفات: العمق والدورات يطابقان قيد القاعدة؛ تكرار الاسم عند إعادة التسمية يلتقطه الفهرس الفريد ← ٤٠٩. المخزون يُقفل قبل الحساب. الصور: كلّها أو لا شيء |
| `phase1-backend/src/services/storefront-config.service.ts` | 573 | 2026-11-22 (كاملاً) | الحسابات الاجتماعيّة أسماء مستخدمين فقط (بادئة ثابتة في الكود، لا رابط ولا مخطّط)؛ الهاتف يُوحَّد؛ الشريط لا يُفعَّل بلا نصّ؛ الشعار: الصفّ أوّلاً ثمّ حذف القديم، وتنظيف عند الفشل |
| `phase1-backend/src/services/search/postgres-trigram.engine.ts` | 442 | — | لم يُقرأ |
| `phase1-backend/src/services/product-review.service.ts` | 424 | 2026-11-22 (كاملاً) | المراجعة تشترط طلباً مكتملاً يحوي المنتج (المعرّف على الصفّ)؛ التاجر يخفي النصّ لا الدرجة، بسبب مكتوب في سجلّ التدقيق؛ الاسم الأوّل فقط. ملاحظة: القائمة العامّة لا تفحص أنّ المنتج حيّ — بلا أثر، تحتاج معرّفه |
| `phase1-backend/src/services/whatsapp-manual.service.ts` | 358 | 2026-11-22 (كاملاً) | م-٣. القوالب بقائمة متغيّرات مسموحة؛ السجلّ يحفظ ما رسمه الخادم لا ما أرسله العميل؛ الطلب مقيّد بالمتجر |
| `phase1-backend/src/services/analytics.service.ts` | 337 | — | لم يُقرأ |
| `phase1-backend/src/services/incidents.service.ts` | 327 | — | لم يُقرأ |
| `phase1-backend/src/services/notification-settings.service.ts` | 326 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-search.service.ts` | 313 | — | لم يُقرأ |
| `phase1-backend/src/services/storefront-seo.service.ts` | 307 | — | لم يُقرأ |
| `phase1-backend/src/services/store-banner.service.ts` | 295 | — | لم يُقرأ |
| `phase1-backend/src/services/list-page.ts` | 289 | — | لم يُقرأ |
| `phase1-backend/src/services/feature-flags.service.ts` | 287 | — | لم يُقرأ |
| `phase1-backend/src/services/order-notes.service.ts` | 258 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-home.service.ts` | 250 | — | لم يُقرأ |
| `phase1-backend/src/services/prescription.service.ts` | 245 | 2026-11-22 (كاملاً) | ت-٦. الرفع: تحقّق البايتات قبل أيّ كتابة، حدّ التخزين قبل التخزين، انتقال الحالة مشروط، وحذف الملفّ إن تراجعت المعاملة. القراءة: ملكيّة الطلب للزبون، والمتجر للتاجر |
| `phase1-backend/src/services/soft-delete/delete-preview.service.ts` | 240 | — | لم يُقرأ |
| `phase1-backend/src/services/abandoned-cart.service.ts` | 237 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-brand.service.ts` | 234 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-health.service.ts` | 229 | — | لم يُقرأ |
| `phase1-backend/src/services/store-traffic.service.ts` | 221 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-audit.service.ts` | 216 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-monthly-report.service.ts` | 212 | — | لم يُقرأ |
| `phase1-backend/src/services/store-verification.service.ts` | 209 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-pulse.service.ts` | 204 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-contact.service.ts` | 203 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-store.service.ts` | 195 | — | لم يُقرأ |
| `phase1-backend/src/services/image-embedding.ts` | 190 | — | لم يُقرأ |
| `phase1-backend/src/services/customer-directory.service.ts` | 187 | — | لم يُقرأ |
| `phase1-backend/src/services/recommendation.service.ts` | 181 | — | لم يُقرأ |
| `phase1-backend/src/services/soft-delete/audit-log.service.ts` | 174 | — | لم يُقرأ |
| `phase1-backend/src/services/wishlist.service.ts` | 173 | — | لم يُقرأ |
| `phase1-backend/src/services/stock-forecast.service.ts` | 169 | — | لم يُقرأ |
| `phase1-backend/src/services/order-print.service.ts` | 163 | — | لم يُقرأ |
| `phase1-backend/src/services/soft-delete/fk-violations.ts` | 162 | — | لم يُقرأ |
| `phase1-backend/src/services/marketing-settings.service.ts` | 138 | — | لم يُقرأ |
| `phase1-backend/src/services/order-tracking.service.ts` | 132 | 2026-11-22 (كاملاً) | عامّ بلا دخول: مطابقة واحدة (المتجر، رقم الطلب، الهاتف)؛ كلّ إخفاق ٤٠٤ واحد؛ الحقول قائمة سماح محدّدة؛ مفتاح الحدّ لا يأخذ نصّاً حرّاً |
| `phase1-backend/src/services/platform-overview.service.ts` | 129 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-onboarding.service.ts` | 127 | — | لم يُقرأ |
| `phase1-backend/src/services/search/search.types.ts` | 119 | — | لم يُقرأ |
| `phase1-backend/src/services/reserved-slugs.ts` | 117 | — | لم يُقرأ |
| `phase1-backend/src/services/owner-account.service.ts` | 113 | 2026-11-22 (كاملاً) | قُرئ في الدفعة ٣ (م-٣ هناك) |
| `phase1-backend/src/services/governorates.ts` | 104 | — | لم يُقرأ |
| `phase1-backend/src/services/messaging-caps.service.ts` | 94 | — | لم يُقرأ |
| `phase1-backend/src/services/inventory-movements.service.ts` | 82 | — | لم يُقرأ |
| `phase1-backend/src/services/soft-delete/constants.ts` | 80 | — | لم يُقرأ |
| `phase1-backend/src/services/search/index.ts` | 74 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-directory.service.ts` | 68 | — | لم يُقرأ |
| `phase1-backend/src/services/store-bootstrap.service.ts` | 65 | — | لم يُقرأ |
| `phase1-backend/src/services/keyset-cursor.ts` | 36 | — | لم يُقرأ |

## النتائج

(تُضاف بالترتيب الذي تُكتشف به: ح = حرج، م = مهمّ، ت = تحسين، ر = ترتيب)

### [م-١] موظّف يدير الفريق يرقّي نفسه — مهمّ (أمان: تصعيد صلاحيّات)
- المكان: مسارات الفريق (`http/routes/team.ts`) و`staff.service.ts`. `team.manage` صلاحيّة مدير المتجر ويمكن للتاجر منحها لموظّف عاديّ؛ المسارات تتحقّق من حملها فقط. فالموظّف العاديّ الممنوح إيّاها كان يغيّر دوره هو إلى مدير متجر (كلّ الصلاحيّات، `settings.manage` منها)، أو يسمح لنفسه بأيّ صلاحيّة، أو ينشئ مديراً جديداً، أو يمنح زميلاً ما لا يملك.
- الحالة: **مُصلَح** — `27ea17a`: `assertCanDelegate` — لا يغيّر الموظّف عضويّته (٤٠٣ `CANNOT_CHANGE_OWN_MEMBERSHIP`)، ولا يمنح بدور أو استثناء صلاحيّةً لا يملكها (٤٠٣ `DELEGATION_EXCEEDS_OWN`). التاجر لا يتأثّر. الاختبار (`phase14`): أربع طرق للصعود — ترقية النفس ٢٠٠ قبل؛ كلّها ٤٠٣ بعد، وإضافة زميل عاديّ ما زالت تعمل. (طاقم المنصّة: إدارته للمالك وحده — لا ثغرة مماثلة.)

### [م-٢] كشف الناقل يطلب نقداً من زبون دفع مسبقاً — مهمّ (مال)
- المكان: `delivery.service.ts` — كشف الناقل (`cod_amount_iqd`) ومطابقة النقد. «النقد المطلوب» كان إجماليّ الطلب لكلّ طلب سُلِّم. منذ M13a يُدفع طلب البطاقة (وتطبيق الشريك) قبل خروجه، وخطّة الأقساط تدفع البضاعة ويبقى أجر التوصيل نقداً. فالكشف كان يأمر الناقل بتحصيل المبلغ كاملاً مرّة ثانية من زبون دفع، والمطابقة تحمّل الناقل نقداً لم يقبضه.
- الحالة: **مُصلَح** — `cashToCollectIqd`: مدفوع ← ٠، أقساط ← أجر التوصيل، غير ذلك ← الإجماليّ؛ في الكشف والمطابقة معاً، وطلب لا نقد فيه لا يظهر في قائمة «لم يُستلم». القائمة تحمل `codIqd` والشاشة تعرضه بدل الإجماليّ (يبقى `totalIqd` في الاستجابة إجماليّ الطلب)؛ صفّ الكشف في `manifestLine`. الاختبار (`delivery:test`): طلب بطاقة وطلب أقساط — ٤٥٠٠٠ و٤٥٠٠٠ قبل؛ ٠ و٥٠٠٠ بعد (مرّتان).
- متبقٍّ للمالك: التحويل اليدويّ (`awaiting_transfer`) يبقى على الإجماليّ — لا خطوة في الكود تؤكّد وصول التحويل، فلا يُعرف أنّه دُفع.

### [م-٣] «جهّز مبلغ الدفع» لزبون دفع — مهمّ (مال، من عائلة م-٢)
- المكان: رسالة «المندوب في الطريق» في القناتين — قالب واتساب اليدويّ (`whatsapp-manual.service.ts`) يقول «يرجى تجهيز مبلغ الدفع عند الاستلام: {{المبلغ}}» والمبلغ إجماليّ الطلب، وبريد الإشعار (`outbox-worker.ts`) يقول «يرجى تجهيز مبلغ الدفع عند الاستلام» لكلّ طلب. زبون دفع بالبطاقة أو بالشريك يُطلب منه الدفع ثانيةً، وزبون الأقساط يُطلب منه الإجماليّ بدل أجر التوصيل.
- الحالة: **مُصلَح** — واتساب: `{{المبلغ}}` في قالب المندوب هو النقد المتبقّي (`cashToCollectIqd` من م-٢)، والسطر الذي يذكره يُحذف حين لا شيء متبقٍّ (كنمط سطر رابط التتبّع)؛ وجملة الدفع في القالب الافتراضيّ صارت سطراً وحدها لذلك. القوالب الأخرى تبقى على إجماليّ الطلب. البريد: `enqueueCourierDispatched` يقرأ الدفع داخل معاملة الانتقال ويحفظ `cashIqd`، والرسالة (نُقلت إلى `notifications/courier-message.ts`، فصغُر العامل) تقول المبلغ أو «طلبك مدفوع مسبقاً»؛ صفّ قديم بلا `cashIqd` يبقى على جملته القديمة. الاختبارات: `wa1` (مدفوع وأقساط) و`cd1` (مدفوع، ونقد عند الاستلام بمبلغه) — فشلت قبل، ونجحت بعد مرّتين.
- ملاحظة: قالب كتبه التاجر بنفسه للمندوب وفيه {{المبلغ}} في سطر واحد مع كلام آخر — يُحذف ذلك السطر كلّه للطلب المدفوع. المقبول أهون من مطالبة زبون دفع.

### [ت-١] صورة الغلاف خارج عدّاد التخزين — تحسين
- المكان: `merchantUsage`. رفع الغلاف يفحص حدّ التخزين، والعدّاد لم يجمع أحجام الأغلفة.
- الحالة: **مُصلَح** — `5c00cbc`. الاختبار (`market:stores`): غلاف ٣ ميغابايت — لم يتحرّك العدّاد قبل (١ ← ١)، ويزيد ٣ بعد.

### [ت-٢] تقسيم ملفّ الخطط والاشتراكات — تحسين
- `379343f`: `entitlement.service.ts` ← `services/entitlement/{plans,usage,subscribe,catalog,merchants}.ts`، نقلٌ حرفيّ (من تقسيمات الخطّة المسمّاة لهذه الدفعة).

### [ت-٣] طلب الترقية يُحسم مرّتين بمديرين معاً — تحسين
- المكان: `decideUpgradeRequest`. «قيد الانتظار» يُقرأ خارج المعاملة: موافقة ورفض معاً يمرّان كلاهما — الاشتراك يتغيّر والطلب قد يُسجَّل «مرفوضاً».
- الحالة: **مُصلَح** — `33118af`: الحسم يُحجز أوّلاً بتحديث مشروط. الاختبار (`plans`): موافقة ورفض معاً — كلاهما ٢٠٠ قبل (٣ من ٣)؛ واحد ٢٠٠ وواحد ٤٠٩ بعد، والاشتراك يطابق القرار الفائز.

### [ت-٤] حدود الخطّة تُتجاوز بطلبات متزامنة — تحسين
- المكان: `assertWithinPlanLimit` (`entitlement/usage.ts`)، و`createStoreStaff`. الفحص يقرأ الاستهلاك ثمّ يكتب، بلا قفل وبعزل Read Committed: طلبات متزامنة تقرأ الرقم نفسه فتمرّ كلّها. وإضافة الموظّف كانت تفحص قبل المعاملة أصلاً.
- الحالة: **مُصلَح** — داخل المعاملة يُقفَل صفّ التاجر (`FOR UPDATE`) قبل الفحص، فتنتظر الفحوص المتزامنة للتاجر نفسه دورها؛ وإضافة الموظّف تعيد الفحص داخل المعاملة التي تملأ المقعد (الفرعان: موظّف جديد وربط موظّف موجود). الاختبار (`phase16`): خطّة بمقعد واحد، خمسة طلبات معاً — منتجات ٢٠١×٥ وموظّفون ٢٠١×٥ قبل؛ واحد ٢٠١ لكلّ منهما بعد (مرّتان متتاليتان).
- مستثنى عمداً: حدّ الطلبات الشهريّة — الدفع بعزل Serializable يُسقط الثاني من طلبين قرأا العدد نفسه، وق-٢٢٢ يُبقيه بلا أقفال.
- متبقٍّ مقبول: فحوص حجم الصور (منتج، شعار، غلاف، شريحة، وصفة) تجري قبل الرفع وخارج معاملة — الرفع إلى التخزين لا يُقفَل حوله. التجاوز الممكن محدود بحجم الرفعات المتزامنة.

### [ت-٥] تقسيم ملفّ التوصيل — تحسين
- `d500773`: `delivery.service.ts` (٤٧١ سطراً) ← `services/delivery/{fields,handover,manifest,reconciliation}.ts`، نقلٌ حرفيّ قبل إصلاح م-٢ (الملفّ كان فوق الحدّ ولا ينمو). عيبان قديمان أُزيلا ليمرّ الحارس بلا تغيير سلوك: سطر تعليق طويل، ودالّة المطابقة فوق ٦٠ سطراً (`foldOrder`، `sumCouriers`).

### [ت-٦] الوصفة تُحسم مرّتين بمراجعَين معاً — تحسين
- المكان: `reviewOrderPrescription`. «بانتظار المراجعة» يُقرأ بلا قفل ثمّ يُكتب القرار: موافقة ورفض معاً يمرّان كلاهما، والأخير يغلب — فيُقال لأحدهما «موافَق» عن وصفة يسجّلها الطلب مرفوضة (نمط ت-٣).
- الحالة: **مُصلَح** — القرار يُحجز أوّلاً بتحديث مشروط على الحالة؛ الثاني يجد لا شيء معلّقاً فيُرفض بـ٤٢٢ `PRESCRIPTION_NOT_REVIEWABLE` (الرمز نفسه للمراجعة المكرّرة). الاختبار (`phase20b1`): أربعة قرارات معاً — ٢٠٠×٤ قبل (ثلاث مرّات)؛ واحد ٢٠٠ والسجلّ يطابقه بعد (ثلاث مرّات).

### ملاحظات
- `pos.service.ts`: سعر السطر يحدّده الكاشير (مقصود — بيع في المحلّ خلف `pos.sell`).
- `availability.service.ts`: «إعادة التفعيل» من المنصّة (`active`) تُكتب على أيّ متجر، لا الموقوف وحده — فلو أرسلها مدير المنصّة لمتجر أغلقه التاجر للصيانة لفتحه. مسجَّل في التدقيق وخلف صلاحيّة المنصّة؛ يُعرض على المالك إن أراد قصرها على الموقوف.
- `csv-transfer.service.ts` مع ت-٤: الاستيراد معاملة واحدة (حتّى ٢٠٠٠ صفّ، مهلتها دقيقتان) تحمل قفل التاجر حتّى تنتهي — فإنشاء منتج يدويّ لنفس التاجر أثناءها ينتظر، وقد يتجاوز مهلة معاملته (٥ ثوانٍ) فيُرفض. مقبول: الحالة نادرة (التاجر نفسه، في اللحظة نفسها)، والبديل يترك الحدّ قابلاً للتجاوز.
- `platform-staff.service.ts`: كلمة المرور التي يكتبها المالك للموظّف لا تُفرض تغييراً (بخلاف موظّفي المتاجر، ١٤-ب). أثرها محدود: المالك صاحب السلطة كلّها أصلاً، والتسجيل في المصادقة الثنائيّة شرط قبل أيّ عمل. لكنّ من تسرّبت إليه الكلمة قبل أن يسجّل الموظّف قد يسجّل جهازه هو أوّلاً — فلتُسلَّم الكلمة والموظّف حاضر.
- `return-request.service.ts`: الموافقة (انتقال الطلب) وتحديث طلب الإرجاع في خطوتين؛ وطلبا إرجاع متزامنان قد يُفتحان. بلا ضرر ماليّ — الانتقال محميّ بالنسخة.

### فحص آليّ على كلّ ملفّات الدفعة: قراءة أو كتابة بالمعرّف وحده
- بحثتُ في كلّ ملفّ لم يُقرأ بعد عن `update/delete/findUnique…({ where: { id } })` بلا `storeId`. كلّ النتائج إمّا `storeId` من سياق الخادم، أو معرّف صفّ قُرئ قبله داخل المتجر؛ والاثنان الآتيان من الطلب مباشرة (`updateCategory`، `reviewPrescription`) مقيّدان قبل الكتابة. **لا وصول عبر المتاجر.**
- `registration.service.ts`: `storeForHost` يقبل `customDomain` بلا علامة تحقّق — لكن لا مسار في الكود يكتب `customDomain`؛ يُضبط من خارج التطبيق. يُراجع حين يُبنى ربط النطاقات.
