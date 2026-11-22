# سجلّ الدفعة ٥ — الإشعارات والمهامّ والنسخ الاحتياطيّ والسجلّ والإعداد

قائمة الفحص في [README.md](README.md). كلّ ملفّ يُقرأ كاملاً؛ سطره هنا يُحدَّث عند الانتهاء منه.
النطاق (الخطّة §٣، الدفعة ٥): `notifications` و`jobs` و`backup` و`logging` و`config`، والمهامّ المجدولة المؤجّلة من الدفعة ٤ (`retention-job`، `reservation-expiry-job`، `purge-job`، `retention`، `config.service`) — وأُضيف ما لم تشمله أيّ دفعة: `db` و`observability` و`events` و`demo` و`src/config.ts` و`src/index.ts` و`server/index.ts`. 35 ملفّاً، 7,470 سطراً.
التقسيم المسمّى في الخطّة لهذه الدفعة: `outbox-worker.ts`.

| الملفّ | الأسطر | قُرئ في | النتائج |
|---|---|---|---|
| `phase1-backend/src/notifications/outbox-worker.ts` | 802 | — | لم يُقرأ |
| `phase1-backend/src/services/config.service.ts` | 582 | — | لم يُقرأ |
| `phase1-backend/src/config/environment-report.ts` | 423 | — | لم يُقرأ |
| `phase1-backend/src/notifications/notification-provider.ts` | 401 | — | لم يُقرأ |
| `phase1-backend/src/backup/backup-envelope.ts` | 393 | — | لم يُقرأ |
| `phase1-backend/src/notifications/notification-outbox.service.ts` | 353 | — | لم يُقرأ |
| `phase1-backend/src/services/soft-delete/purge-job.ts` | 349 | — | لم يُقرأ |
| `phase1-backend/src/notifications/messaging-compliance.service.ts` | 336 | — | لم يُقرأ |
| `server/index.ts` | 322 | — | لم يُقرأ |
| `phase1-backend/src/backup/backup-storage.ts` | 314 | — | لم يُقرأ |
| `phase1-backend/src/logging/logger.ts` | 252 | — | لم يُقرأ |
| `phase1-backend/src/services/retention-job.ts` | 220 | — | لم يُقرأ |
| `phase1-backend/src/notifications/trial-expiry-scanner.ts` | 219 | — | لم يُقرأ |
| `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | 218 | — | لم يُقرأ |
| `phase1-backend/src/notifications/worker-entry.ts` | 212 | — | لم يُقرأ |
| `phase1-backend/src/services/reservation-expiry-job.ts` | 203 | — | لم يُقرأ |
| `phase1-backend/src/notifications/merchant-digest-scanner.ts` | 180 | — | لم يُقرأ |
| `phase1-backend/src/notifications/resend-webhook.ts` | 164 | — | لم يُقرأ |
| `phase1-backend/src/observability/sentry.ts` | 154 | — | لم يُقرأ |
| `phase1-backend/src/demo/demo-mode.ts` | 150 | — | لم يُقرأ |
| `phase1-backend/src/notifications/restock-scanner.ts` | 139 | — | لم يُقرأ |
| `phase1-backend/src/logging/redact.ts` | 133 | — | لم يُقرأ |
| `phase1-backend/src/jobs/scheduler.ts` | 127 | — | لم يُقرأ |
| `phase1-backend/src/events/domain-events.ts` | 112 | — | لم يُقرأ |
| `phase1-backend/src/services/retention.ts` | 110 | — | لم يُقرأ |
| `phase1-backend/src/config.ts` | 107 | — | لم يُقرأ |
| `phase1-backend/src/backup/backup-policy.ts` | 100 | — | لم يُقرأ |
| `phase1-backend/src/logging/context.ts` | 87 | — | لم يُقرأ |
| `phase1-backend/src/db/serializable-retry.ts` | 73 | — | لم يُقرأ |
| `phase1-backend/src/db/database-url.ts` | 70 | — | لم يُقرأ |
| `phase1-backend/src/jobs/outbox-signal.ts` | 65 | — | لم يُقرأ |
| `phase1-backend/src/notifications/maintenance-message.ts` | 50 | — | لم يُقرأ |
| `phase1-backend/src/notifications/courier-message.ts` | 26 | — | لم يُقرأ |
| `phase1-backend/src/index.ts` | 17 | — | لم يُقرأ |
| `phase1-backend/src/db/prisma.ts` | 7 | — | لم يُقرأ |

## النتائج

(تُضاف بالترتيب الذي تُكتشف به: ح = حرج، م = مهمّ، ت = تحسين، ر = ترتيب)

### ملاحظات

