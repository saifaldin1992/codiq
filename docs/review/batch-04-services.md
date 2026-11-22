# سجلّ الدفعة ٤ — باقي خدمات الخادم

قائمة الفحص في [README.md](README.md). كلّ ملفّ يُقرأ كاملاً؛ سطره هنا يُحدَّث عند الانتهاء منه.
النطاق (الخطّة §٣): خدمات `phase1-backend/src/services/` التي لم تُقرأ في الدفعتين ٢ و٣ — 68 ملفّاً، 20,224 سطراً.
المهامّ المجدولة (`retention-job`، `reservation-expiry-job`، `purge-job`، `retention`) و`config.service` للدفعة ٥ كما في الخطّة.
الترتيب: ما يمسّ المال والصلاحيّات أوّلاً.

| الملفّ | الأسطر | قُرئ في | النتائج |
|---|---|---|---|
| `phase1-backend/src/services/pos.service.ts` | 669 | — | لم يُقرأ |
| `phase1-backend/src/services/entitlement.service.ts` | 1,028 | — | لم يُقرأ |
| `phase1-backend/src/services/return-request.service.ts` | 285 | — | لم يُقرأ |
| `phase1-backend/src/services/return-inspection.service.ts` | 342 | — | لم يُقرأ |
| `phase1-backend/src/services/order-self-cancel.service.ts` | 108 | — | لم يُقرأ |
| `phase1-backend/src/services/order-bulk.service.ts` | 173 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-staff.service.ts` | 335 | — | لم يُقرأ |
| `phase1-backend/src/services/staff.service.ts` | 310 | — | لم يُقرأ |
| `phase1-backend/src/services/registration.service.ts` | 318 | — | لم يُقرأ |
| `phase1-backend/src/services/manual-provisioning.service.ts` | 223 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-suspension.service.ts` | 185 | — | لم يُقرأ |
| `phase1-backend/src/services/csv-transfer.service.ts` | 895 | — | لم يُقرأ |
| `phase1-backend/src/services/csv.ts` | 119 | — | لم يُقرأ |
| `phase1-backend/src/services/availability.service.ts` | 1,066 | — | لم يُقرأ |
| `phase1-backend/src/services/maintenance.service.ts` | 760 | — | لم يُقرأ |
| `phase1-backend/src/services/delivery-rates.service.ts` | 104 | — | لم يُقرأ |
| `phase1-backend/src/services/delivery.service.ts` | 471 | — | لم يُقرأ |
| `phase1-backend/src/services/soft-delete/soft-delete.service.ts` | 1,348 | — | لم يُقرأ |
| `phase1-backend/src/services/product-catalog.service.ts` | 1,177 | — | لم يُقرأ |
| `phase1-backend/src/services/storefront-config.service.ts` | 573 | — | لم يُقرأ |
| `phase1-backend/src/services/search/postgres-trigram.engine.ts` | 442 | — | لم يُقرأ |
| `phase1-backend/src/services/product-review.service.ts` | 424 | — | لم يُقرأ |
| `phase1-backend/src/services/whatsapp-manual.service.ts` | 358 | — | لم يُقرأ |
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
| `phase1-backend/src/services/prescription.service.ts` | 245 | — | لم يُقرأ |
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
| `phase1-backend/src/services/order-tracking.service.ts` | 132 | — | لم يُقرأ |
| `phase1-backend/src/services/platform-overview.service.ts` | 129 | — | لم يُقرأ |
| `phase1-backend/src/services/merchant-onboarding.service.ts` | 127 | — | لم يُقرأ |
| `phase1-backend/src/services/search/search.types.ts` | 119 | — | لم يُقرأ |
| `phase1-backend/src/services/reserved-slugs.ts` | 117 | — | لم يُقرأ |
| `phase1-backend/src/services/owner-account.service.ts` | 113 | — | لم يُقرأ |
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
