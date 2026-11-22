# تقرير الدفعة ٥ — الإشعارات والمهامّ والنسخ الاحتياطيّ والسجلّ والإعداد

## الخلاصة

**قُرئ كلّ ملفّ من ملفّات الدفعة الـ٣٥ سطراً بسطر** (٧٬٤٧٠ سطراً؛ السجلّ: [batch-05-infra.md](batch-05-infra.md)): الإشعارات
وعاملها والماسحات، والمهامّ المجدولة، والنسخ الاحتياطيّ وتشفيره، والسجلّ والتقنيع، والإعداد وتقرير البيئة — وأُضيف إليها ما لم
تشمله أيّ دفعة (`db` و`observability` و`events` و`demo` و`src/config.ts` و`src/index.ts` و`server/index.ts`). أُغلقت بتشغيل محلّيّ
لكلّ خطوات CI: ٢٠٣ خطوة (التكامل والمتصفح)، نجحت كلّها.

**كلّ إصلاح معه اختبار رأيته يفشل قبل الإصلاح وينجح بعده** (مرّتين على الأقلّ).

| الدرجة | العدد | النتائج |
|---|---|---|
| حرج | ٠ | — |
| مهمّ | ٠ | — |
| تحسين | ٤ | ت-٢ رسالة تُرسل مرّتين حين تطول الدفعة (نسختان في الإنتاج) · ت-٣ «نبّهني» ثانيةً على المنتج نفسه لا يصل أبداً · ت-٤ بريد تغيّر الحالة يطبع رموز القاعدة بالإنكليزيّة · ت-١ تقسيم عامل الصندوق (المسمّى في الخطّة) |

**تحقّق بلا إصلاح:** المهامّ المجدولة تعمل في النسختين معاً ولا يتكرّر شيء من رسائلها (فهرس `dedupe` الفريد بمتجر وبلا متجر)؛
تشفير النسخ يكشف القطع والترتيب والتلاعب؛ النسخ لا تنتقل للحاوية المشتركة إن كانت المخصّصة ناقصة؛ السجلّ وSentry يقنّعان الأسرار
والبريد والهاتف؛ تحرير الحجز المنتهي لا يمسّ المخزون (لم يُخصم أصلاً)؛ تقرير البيئة يكشف مفاتيح الاختبار المتروكة والاتّصال بلا TLS.

**لم يُحذف كود مستعمل.** تغيّرات يراها الناس: بريد تغيّر الحالة بالعربيّة؛ «نبّهني» يعمل مرّة ثانية؛ لا بريد مكرّر.

**ملاحظات للمالك (لا إصلاح):** بلا مزوّد بريد تُسقط الرسائل بدل أن تُحفظ · الشكوى تُنسب لآخر متجر أرسل (يحتاج حفظ معرّف
الرسالة) · `Idempotency-Key` عند Resend طبقة ثانية خلف ت-٢ · زبون محظور يصله «سلّتك بانتظارك» وقسيمة الاسترداد تُفحص «مفعّلة» لا «سارية» ·
حالات نادرة قد توقف حلقة انتهاء التجربة أو الحذف النهائيّ · فكّ النسخة يُخرج قبل التحقّق من نهايتها · متغيّر `release` في Sentry.

---

## كلّ كومِت، كلّ ملفّ، كلّ مدى أسطر

**الكومِتات:** ٨ · **الملفّات:** ١٢ · **أسطر أُضيفت:** ١٬٢٠١ · **أسطر حُذفت:** ٩٧٢

المدى: `6a32519..HEAD` — أعيد توليده بـ `node tools/review-report.mjs --from 6a32519 --to HEAD …`

## 6a32519 — docs(review): batch 5 opened — the log, every file with a row

التاريخ: 2026-11-22

> Notifications, jobs, backup, logging and configuration (plan §3, batch 5),
> the scheduled jobs deferred from batch 4, and what no batch covered yet —
> db, observability, events, demo, src/config.ts, src/index.ts and
> server/index.ts. 35 files, 7,470 lines; the plan's named split for the batch
> is outbox-worker.ts.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | أُضيف | 50 | 0 | — ← 1–50 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/docs/review/batch-05-infra.md b/docs/review/batch-05-infra.md
new file mode 100644
index 0000000..ee3d10c
--- /dev/null
+++ b/docs/review/batch-05-infra.md
@@ -0,0 +1,50 @@
+# سجلّ الدفعة ٥ — الإشعارات والمهامّ والنسخ الاحتياطيّ والسجلّ والإعداد
+
+قائمة الفحص في [README.md](README.md). كلّ ملفّ يُقرأ كاملاً؛ سطره هنا يُحدَّث عند الانتهاء منه.
+النطاق (الخطّة §٣، الدفعة ٥): `notifications` و`jobs` و`backup` و`logging` و`config`، والمهامّ المجدولة المؤجّلة من الدفعة ٤ (`retention-job`، `reservation-expiry-job`، `purge-job`، `retention`، `config.service`) — وأُضيف ما لم تشمله أيّ دفعة: `db` و`observability` و`events` و`demo` و`src/config.ts` و`src/index.ts` و`server/index.ts`. 35 ملفّاً، 7,470 سطراً.
+التقسيم المسمّى في الخطّة لهذه الدفعة: `outbox-worker.ts`.
+
+| الملفّ | الأسطر | قُرئ في | النتائج |
+|---|---|---|---|
+| `phase1-backend/src/notifications/outbox-worker.ts` | 802 | — | لم يُقرأ |
+| `phase1-backend/src/services/config.service.ts` | 582 | — | لم يُقرأ |
+| `phase1-backend/src/config/environment-report.ts` | 423 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/notification-provider.ts` | 401 | — | لم يُقرأ |
+| `phase1-backend/src/backup/backup-envelope.ts` | 393 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/notification-outbox.service.ts` | 353 | — | لم يُقرأ |
+| `phase1-backend/src/services/soft-delete/purge-job.ts` | 349 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/messaging-compliance.service.ts` | 336 | — | لم يُقرأ |
+| `server/index.ts` | 322 | — | لم يُقرأ |
+| `phase1-backend/src/backup/backup-storage.ts` | 314 | — | لم يُقرأ |
+| `phase1-backend/src/logging/logger.ts` | 252 | — | لم يُقرأ |
+| `phase1-backend/src/services/retention-job.ts` | 220 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/trial-expiry-scanner.ts` | 219 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | 218 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/worker-entry.ts` | 212 | — | لم يُقرأ |
+| `phase1-backend/src/services/reservation-expiry-job.ts` | 203 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/merchant-digest-scanner.ts` | 180 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/resend-webhook.ts` | 164 | — | لم يُقرأ |
+| `phase1-backend/src/observability/sentry.ts` | 154 | — | لم يُقرأ |
+| `phase1-backend/src/demo/demo-mode.ts` | 150 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/restock-scanner.ts` | 139 | — | لم يُقرأ |
+| `phase1-backend/src/logging/redact.ts` | 133 | — | لم يُقرأ |
+| `phase1-backend/src/jobs/scheduler.ts` | 127 | — | لم يُقرأ |
+| `phase1-backend/src/events/domain-events.ts` | 112 | — | لم يُقرأ |
+| `phase1-backend/src/services/retention.ts` | 110 | — | لم يُقرأ |
+| `phase1-backend/src/config.ts` | 107 | — | لم يُقرأ |
+| `phase1-backend/src/backup/backup-policy.ts` | 100 | — | لم يُقرأ |
+| `phase1-backend/src/logging/context.ts` | 87 | — | لم يُقرأ |
+| `phase1-backend/src/db/serializable-retry.ts` | 73 | — | لم يُقرأ |
+| `phase1-backend/src/db/database-url.ts` | 70 | — | لم يُقرأ |
+| `phase1-backend/src/jobs/outbox-signal.ts` | 65 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/maintenance-message.ts` | 50 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/courier-message.ts` | 26 | — | لم يُقرأ |
+| `phase1-backend/src/index.ts` | 17 | — | لم يُقرأ |
+| `phase1-backend/src/db/prisma.ts` | 7 | — | لم يُقرأ |
+
+## النتائج
+
+(تُضاف بالترتيب الذي تُكتشف به: ح = حرج، م = مهمّ، ت = تحسين، ر = ترتيب)
+
+### ملاحظات
+
```

</details>

## f88bbd0 — refactor(notifications): split outbox-worker.ts by job, verbatim (review batch 5, ت-١)

التاريخ: 2026-11-22

> The plan's named split for batch 5, made before reading it for fixes.
> outbox-worker.ts (802 lines) → notifications/outbox/{render,batch,loop}.ts:
> rendering the messages, processing a batch, and the worker loop. The old file
> re-exports exactly what it exported, so no importer changes. All 17 top-level
> statements present verbatim (checked by script); the shape debt moves as it
> was (`--split`) — processOutboxBatch alone is about 390 lines.
> cd1, md3 and pg3 pass.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | عُدّل | 3 | 0 | — ← 49–51 |
| `phase1-backend/src/notifications/outbox-worker.ts` | عُدّل | 13 | 793 | 8–32 ← —، 34–37 ← 9–10، 39–802 ← 12–22 |
| `phase1-backend/src/notifications/outbox/batch.ts` | أُضيف | 446 | 0 | — ← 1–446 |
| `phase1-backend/src/notifications/outbox/loop.ts` | أُضيف | 149 | 0 | — ← 1–149 |
| `phase1-backend/src/notifications/outbox/render.ts` | أُضيف | 223 | 0 | — ← 1–223 |
| `tools/duplicate-baseline.json` | عُدّل | 1 | 1 | 122 ← 122 |
| `tools/shape-baseline.json` | عُدّل | 14 | 4 | 644–647 ← 644–657 |

هذا الكومِت غيّر ١٬٦٤٧ سطراً — كلّ سطر منها: `git show f88bbd0`.

## 5e388b5 — fix(notifications): a message goes out once, even when a batch outlives its claim (review batch 5, ت-٢)

التاريخ: 2026-11-22

> Production runs two instances, each with an outbox worker. The provider is
> allowed 20 seconds, so a 20-row batch can outlast STALE_CLAIM_RECOVERY_MS
> (5 minutes). The other worker then recovered the rows this batch had not
> reached and sent them — and this batch, holding them in memory, sent them
> again; every later write was by id alone and overwrote the other's outcome.
> Before each send the row is re-claimed with a conditional update on the claim
> token (refreshing claimedAt, so a row in flight is never recovered); a row
> taken back is left alone. Every write on a row now goes through settle(),
> conditional on the same token — thirteen copies of one block become one, and
> batch.ts falls under the size limit.
> phase15: two workers, a batch «started six minutes ago» — 8 sends for 4 rows
> before; 4 after (twice; the final test re-run against the old code fails).
> pg3, cd1, md3, marketing:recipient-cap and pr1 pass.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | عُدّل | 6 | 2 | 26 ← 26، 52 ← 52–54، — ← 56–57 |
| `phase1-backend/src/notifications/outbox/batch.ts` | عُدّل | 74 | 116 | — ← 6، — ← 61–72، 131–138 ← 144–146، 144–151 ← 152–154، 213–224 ← 216–222، 239–246 ← 237–239، 254–261 ← 247–249، 273–280 ← 261–263، 296–303 ← 279–281، 313–323 ← 291–296، 336–343 ← 309–311، 355–362 ← 323–325 … (١٦ موضعاً) |
| `phase1-backend/tests/phase15.notifications.integration.ts` | عُدّل | 51 | 0 | — ← 20، — ← 609–658 |
| `tools/shape-baseline.json` | عُدّل | 2 | 2 | 10 ← 10، 646 ← 646 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/docs/review/batch-05-infra.md b/docs/review/batch-05-infra.md
index 08a116e..1b4eb0e 100644
--- a/docs/review/batch-05-infra.md
+++ b/docs/review/batch-05-infra.md
@@ -25,3 +25,3 @@
 | `phase1-backend/src/notifications/merchant-digest-scanner.ts` | 180 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/resend-webhook.ts` | 164 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/resend-webhook.ts` | 164 | 2026-11-22 (كاملاً) | التوقيع بنمط Svix بنافذة ٥ دقائق ومقارنة ثابتة الزمن، والحدث يُسجَّل مرّة؛ الشكوى تُنسب لمتجر أرسل فعلاً. ملاحظة أدناه |
 | `phase1-backend/src/observability/sentry.ts` | 154 | — | لم يُقرأ |
@@ -51,3 +51,7 @@
 
-### ملاحظات
+### [ت-٢] رسالة تُرسل مرّتين حين تطول الدفعة — تحسين
+- المكان: `notifications/outbox/batch.ts`. الإنتاج يشغّل نسختين (`INSTANCES=2`) وفي كلّ منهما عامل. المزوّد يُمهَل ٢٠ ثانية، فدفعة من ٢٠ رسالة قد تدوم أكثر من نافذة استرداد الحجز (٥ دقائق). عندها يستردّ العامل الآخر الرسائل التي لم تصلها الدفعة بعد ويرسلها — والأوّل، وهي في ذاكرته، يرسلها ثانيةً؛ وكلّ كتابة بعدها كانت بالمعرّف وحده فتكتب فوق نتيجة الآخر.
+- الحالة: **مُصلَح** — قبل كلّ إرسال يُعاد الحجز بتحديث مشروط على رمز الحجز (ويُجدَّد `claimedAt` فلا تُستردّ الرسالة وهي تُرسل)؛ ما استُرِدّ يُترك. وكلّ كتابة على الصفّ صارت عبر `settle()` المشروطة بالرمز نفسه (١٣ موضعاً — فصغُر الملفّ تحت الحدّ). الاختبار (`phase15`): عاملان ودفعة «بدأت قبل ستّ دقائق» — ٨ إرسالات لـ٤ رسائل قبل؛ ٤ بعد (مرّتان، وأُعيد إثبات الفشل على الكود القديم).
 
+### ملاحظات
+- `resend-webhook.ts`: الشكوى تُنسب إلى آخر متجر أرسل لهذا العنوان، لأنّ معرّف الرسالة عند المزوّد لا يُحفظ عند الإرسال. زبون يشتري من متجرين ويشكو أحدهما قد تُنسب شكواه إلى الآخر. الحلّ يحتاج عموداً جديداً (معرّف الرسالة عند الإرسال) — يُعرض على المالك.
diff --git a/phase1-backend/src/notifications/outbox/batch.ts b/phase1-backend/src/notifications/outbox/batch.ts
index 199ad0e..9d64fd1 100644
--- a/phase1-backend/src/notifications/outbox/batch.ts
+++ b/phase1-backend/src/notifications/outbox/batch.ts
@@ -5,2 +5,3 @@
 import crypto from "node:crypto";
+import type { Prisma } from "@prisma/client";
 import { storeSupportReplyTo } from "../../services/storefront-config.service.js";
@@ -59,2 +60,14 @@ export interface OutboxBatchResult {
 
+/** Ends this worker's hold on a row — only while the hold is still this worker's (ت-٢). */
+async function settle(
+  id: string,
+  claimToken: string,
+  data: Prisma.NotificationOutboxUpdateManyMutationInput
+) {
+  await prisma.notificationOutbox.updateMany({
+    where: { id, claimToken },
+    data: { ...data, claimToken: null, claimedAt: null },
+  });
+}
+
 export function retryDelaySeconds(attemptCount: number): number {
@@ -130,10 +143,5 @@ export async function processOutboxBatch(
     if (!provider) {
-      await prisma.notificationOutbox.update({
-        where: { id: row.id },
-        data: {
-          status: "skipped",
-          lastOutcome: "no_provider_configured",
-          claimToken: null,
-          claimedAt: null,
-        },
+      await settle(row.id, claimToken, {
+        status: "skipped",
+        lastOutcome: "no_provider_configured",
       });
@@ -143,10 +151,5 @@ export async function processOutboxBatch(
     if (!row.recipient) {
-      await prisma.notificationOutbox.update({
-        where: { id: row.id },
-        data: {
-          status: "skipped",
-          lastOutcome: "no_recipient_address",
-          claimToken: null,
-          claimedAt: null,
-        },
+      await settle(row.id, claimToken, {
+        status: "skipped",
+        lastOutcome: "no_recipient_address",
       });
@@ -212,14 +215,9 @@ export async function processOutboxBatch(
       if (exceeded) {
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          // Spread like the marketing deferral, for the same reason: landing
-          // every held message on the same instant rebuilds tomorrow the pile-up
-          // the cap exists to prevent.
-          data: {
-            status: "retry_scheduled",
-            nextAttemptAt: deferredUntil(now, row.id),
-            lastOutcome: exceeded,
-            claimToken: null,
-            claimedAt: null,
-          },
+        // Spread like the marketing deferral, for the same reason: landing
+        // every held message on the same instant rebuilds tomorrow the pile-up
+        // the cap exists to prevent.
+        await settle(row.id, claimToken, {
+          status: "retry_scheduled",
+          nextAttemptAt: deferredUntil(now, row.id),
+          lastOutcome: exceeded,
         });
@@ -238,10 +236,5 @@ export async function processOutboxBatch(
     if (kind === "marketing" && !row.storeId) {
-      await prisma.notificationOutbox.update({
-        where: { id: row.id },
-        data: {
-          status: "dead_letter",
-          lastOutcome: "marketing_without_store",
-          claimToken: null,
-          claimedAt: null,
-        },
+      await settle(row.id, claimToken, {
+        status: "dead_letter",
+        lastOutcome: "marketing_without_store",
       });
@@ -253,10 +246,5 @@ export async function processOutboxBatch(
         // Terminal, not a retry: consent does not come back on its own.
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          data: {
-            status: "skipped",
-            lastOutcome: "recipient_unsubscribed",
-            claimToken: null,
-            claimedAt: null,
-          },
+        await settle(row.id, claimToken, {
+          status: "skipped",
+          lastOutcome: "recipient_unsubscribed",
         });
@@ -272,10 +260,5 @@ export async function processOutboxBatch(
       ) {
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          data: {
-            status: "skipped",
-            lastOutcome: `recipient_daily_cap:${MARKETING_RECIPIENT_DAILY_CAP}`,
-            claimToken: null,
-            claimedAt: null,
-          },
+        await settle(row.id, claimToken, {
+          status: "skipped",
+          lastOutcome: `recipient_daily_cap:${MARKETING_RECIPIENT_DAILY_CAP}`,
         });
@@ -295,10 +278,5 @@ export async function processOutboxBatch(
         // for such a store; this is the second line for rows created elsewhere.
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          data: {
-            status: "skipped",
-            lastOutcome: "marketing_disabled_for_store",
-            claimToken: null,
-            claimedAt: null,
-          },
+        await settle(row.id, claimToken, {
+          status: "skipped",
+          lastOutcome: "marketing_disabled_for_store",
         });
@@ -312,13 +290,8 @@ export async function processOutboxBatch(
         // and must not consume the retry budget or reach the dead letter.
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          // Spread, not stacked: scheduling every deferral on the same instant
-          // rebuilds tomorrow the exact pile-up the cap exists to prevent.
-          data: {
-            status: "retry_scheduled",
-            nextAttemptAt: deferredUntil(now, row.id),
-            lastOutcome: `daily_cap_deferred:${cap}`,
-            claimToken: null,
-            claimedAt: null,
-          },
+        // Spread, not stacked: scheduling every deferral on the same instant
+        // rebuilds tomorrow the exact pile-up the cap exists to prevent.
+        await settle(row.id, claimToken, {
+          status: "retry_scheduled",
+          nextAttemptAt: deferredUntil(now, row.id),
+          lastOutcome: `daily_cap_deferred:${cap}`,
         });
@@ -335,10 +308,5 @@ export async function processOutboxBatch(
         // to send a non-compliant message.
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          data: {
-            status: "dead_letter",
-            lastOutcome: "missing_unsubscribe_link",
-            claimToken: null,
-            claimedAt: null,
-          },
+        await settle(row.id, claimToken, {
+          status: "dead_letter",
+          lastOutcome: "missing_unsubscribe_link",
         });
@@ -354,10 +322,5 @@ export async function processOutboxBatch(
       if (!message.body.includes(optOut)) {
-        await prisma.notificationOutbox.update({
-          where: { id: row.id },
-          data: {
-            status: "dead_letter",
-            lastOutcome: "missing_unsubscribe_link",
-            claimToken: null,
-            claimedAt: null,
-          },
+        await settle(row.id, claimToken, {
+          status: "dead_letter",
+          lastOutcome: "missing_unsubscribe_link",
         });
@@ -368,2 +331,12 @@ export async function processOutboxBatch(
 
+    // Review batch 5, ت-٢: still ours? Two instances run a worker each, and a batch can outlive
+    // STALE_CLAIM_RECOVERY_MS (20 rows × a 20-second provider timeout). Rows this batch has not
+    // reached yet may have been recovered and sent by the other worker; re-claiming here refuses
+    // them, and refreshing `claimedAt` keeps the row about to go out from being recovered while
+    // it is in flight. Every write after this carries the token for the same reason.
+    const stillOurs = await prisma.notificationOutbox.updateMany({
+      where: { id: row.id, claimToken, status: "processing" },
+      data: { claimedAt: new Date() },
+    });
+    if (stillOurs.count !== 1) continue;
     let outcome: ProviderResult;
@@ -400,12 +373,7 @@ export async function processOutboxBatch(
       // was doing: the assertion passed because of the fixture, not the code.
-      await prisma.notificationOutbox.update({
-        where: { id: row.id },
-        data: {
-          status: "sent",
-          sentAt: now,
-          lastOutcome: outcome.outcome,
-          attemptCount: { increment: 1 },
-          claimToken: null,
-          claimedAt: null,
-        },
+      await settle(row.id, claimToken, {
+        status: "sent",
+        sentAt: now,
+        lastOutcome: outcome.outcome,
+        attemptCount: { increment: 1 },
       });
@@ -417,11 +385,6 @@ export async function processOutboxBatch(
     if (attemptCount >= OUTBOX_MAX_ATTEMPTS) {
-      await prisma.notificationOutbox.update({
-        where: { id: row.id },
-        data: {
-          status: "dead_letter",
-          attemptCount,
-          lastOutcome: outcome.outcome,
-          claimToken: null,
-          claimedAt: null,
-        },
+      await settle(row.id, claimToken, {
+        status: "dead_letter",
+        attemptCount,
+        lastOutcome: outcome.outcome,
       });
@@ -430,12 +393,7 @@ export async function processOutboxBatch(
       const nextAttemptAt = new Date(now.valueOf() + retryDelaySeconds(attemptCount) * 1000);
-      await prisma.notificationOutbox.update({
-        where: { id: row.id },
-        data: {
-          status: "retry_scheduled",
-          attemptCount,
-          nextAttemptAt,
-          lastOutcome: outcome.outcome,
-          claimToken: null,
-          claimedAt: null,
-        },
+      await settle(row.id, claimToken, {
+        status: "retry_scheduled",
+        attemptCount,
+        nextAttemptAt,
+        lastOutcome: outcome.outcome,
       });
diff --git a/phase1-backend/tests/phase15.notifications.integration.ts b/phase1-backend/tests/phase15.notifications.integration.ts
index 8b3188d..3d44cf5 100644
--- a/phase1-backend/tests/phase15.notifications.integration.ts
+++ b/phase1-backend/tests/phase15.notifications.integration.ts
@@ -19,2 +19,3 @@ import {
   retryDelaySeconds,
+  STALE_CLAIM_RECOVERY_MS,
 } from "../src/notifications/outbox-worker.js";
@@ -607,2 +608,52 @@ try {
 
+  // Review batch 5, ت-٢: a batch that outlives the stale-claim window. Production runs two
+  // instances, each with a worker; a provider answering at its 20-second timeout makes a
+  // 20-row batch take longer than STALE_CLAIM_RECOVERY_MS. The second worker then recovers
+  // the rows the first has not reached yet and sends them — and the first, still holding
+  // them in memory, sent them again: every row from the hijack on went out twice.
+  const slowRows = Array.from({ length: 4 }, (_, index) => `slow-${index}`);
+  await prisma.notificationOutbox.createMany({
+    data: slowRows.map((name) => ({
+      storeId: storeA.id,
+      eventType: "low_stock" as const,
+      recipientKind: "merchant" as const,
+      channel: "email" as const,
+      recipient: merchantA.email,
+      nextAttemptAt: new Date(Date.now() - 10 * 60_000),
+      payload: {
+        productName: name,
+        sku: name,
+        stockQuantity: 0,
+        lowStockThreshold: 1,
+        storeName: storeA.name,
+      },
+    })),
+  });
+  const second = new FakeNotificationProvider();
+  class SlowFirst extends FakeNotificationProvider {
+    hijacked = false;
+    override async sendEmail(message: Parameters<FakeNotificationProvider["sendEmail"]>[0]) {
+      if (!this.hijacked) {
+        this.hijacked = true;
+        // The other instance's worker runs a pass NOW, while this batch — claimed «six minutes
+        // ago» — is still on its first row.
+        await processOutboxBatch(second, { batchSize: 10 });
+      }
+      return super.sendEmail(message);
+    }
+  }
+  const first = new SlowFirst();
+  await processOutboxBatch(first, {
+    batchSize: 10,
+    now: new Date(Date.now() - STALE_CLAIM_RECOVERY_MS - 60_000),
+  });
+  const sentSlow = [...first.sent, ...second.sent].filter((message) =>
+    slowRows.some((name) => message.body.includes(name))
+  );
+  assert.equal(
+    sentSlow.length,
+    slowRows.length,
+    `each row once, even when the batch outlives its claim · first ${first.sent.length}, second ${second.sent.length}`
+  );
+
   // Without a provider the row is marked skipped, never falsely sent.
diff --git a/tools/shape-baseline.json b/tools/shape-baseline.json
index 87e5a0c..94d8692 100644
--- a/tools/shape-baseline.json
+++ b/tools/shape-baseline.json
@@ -9,3 +9,3 @@
   "longLines": 2579,
-  "oversizeFiles": 103,
+  "oversizeFiles": 102,
   "longFunctions": 440
@@ -645,3 +645,3 @@
    "longLines": 0,
-   "oversize": 28,
+   "oversize": 0,
    "longFunctions": 1
```

</details>

## 0666909 — docs(review): batch 5 — five more files read, with their notes

التاريخ: 2026-11-22

> worker-entry, scheduler, notification-provider and notification-outbox read
> in full; the outbox worker's batch logic too (its fix is ت-٢). Verified, not
> changed: two production instances each run the scheduled jobs, and the
> dedupe unique indexes (with and without a store) keep their messages single.
> Notes recorded: a missing mail provider skips mail for good; Resend's
> Idempotency-Key would add a provider-side guard behind ت-٢; a P2002 swallow
> inside a transaction cannot rescue it in Postgres, unreachable here.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | عُدّل | 8 | 5 | 9 ← 9، 12 ← 12، 14 ← 14، 23 ← 23، 31 ← 31، — ← 57–59 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/docs/review/batch-05-infra.md b/docs/review/batch-05-infra.md
index 1b4eb0e..4eb5932 100644
--- a/docs/review/batch-05-infra.md
+++ b/docs/review/batch-05-infra.md
@@ -8,8 +8,8 @@
 |---|---|---|---|
-| `phase1-backend/src/notifications/outbox-worker.ts` | 802 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/outbox-worker.ts` | 802 | 2026-11-22 (كاملاً) | ت-١ (قُسّم ← outbox/{render,batch,loop}.ts). batch: ت-٢. الترتيب بالأولويّة ثمّ الموعد؛ بوّابات الحدود وإلغاء الاشتراك قبل المزوّد؛ إعادة المحاولة أسّيّة ثمّ dead_letter. ملاحظات أدناه |
 | `phase1-backend/src/services/config.service.ts` | 582 | — | لم يُقرأ |
 | `phase1-backend/src/config/environment-report.ts` | 423 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/notification-provider.ts` | 401 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/notification-provider.ts` | 401 | 2026-11-22 (كاملاً) | Resend عبر HTTP بمهلة ٢٠ ثانية و`redirect: error`؛ SMTP بعنوان IPv4 مع `servername`. ملاحظات أدناه |
 | `phase1-backend/src/backup/backup-envelope.ts` | 393 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/notification-outbox.service.ts` | 353 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/notification-outbox.service.ts` | 353 | 2026-11-22 (كاملاً) | كلّ صفّ يُكتب في معاملة الحدث نفسه؛ إشعار تغيّر الحالة لا يُرسل للتاجر عمّا فعله هو. ملاحظة أدناه |
 | `phase1-backend/src/services/soft-delete/purge-job.ts` | 349 | — | لم يُقرأ |
@@ -22,3 +22,3 @@
 | `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | 218 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/worker-entry.ts` | 212 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/worker-entry.ts` | 212 | 2026-11-22 (كاملاً) | عامل الإشعارات والمهامّ المجدولة؛ في الإنتاج نسختان كلّ منهما بعاملها — المهامّ ليست مقفلة بين العمليّتين، لكنّ تكرار رسائلها يمنعه فهرس `dedupe` الفريد (بمتجر وبلا متجر) |
 | `phase1-backend/src/services/reservation-expiry-job.ts` | 203 | — | لم يُقرأ |
@@ -30,3 +30,3 @@
 | `phase1-backend/src/logging/redact.ts` | 133 | — | لم يُقرأ |
-| `phase1-backend/src/jobs/scheduler.ts` | 127 | — | لم يُقرأ |
+| `phase1-backend/src/jobs/scheduler.ts` | 127 | 2026-11-22 (كاملاً) | نبضة واحدة كلّ ٣٠ دقيقة والمهامّ متتالية فيها (لكي يغفو Neon)؛ لا تداخل داخل العمليّة، وفشل مهمّة لا يمنع غيرها |
 | `phase1-backend/src/events/domain-events.ts` | 112 | — | لم يُقرأ |
@@ -56,2 +56,5 @@
 ### ملاحظات
+- بلا مزوّد بريد مُعَدّ تُعلَّم الرسائل «skipped» نهائيّاً (`no_provider_configured`) — لا تُحفظ لتُرسل حين يُعَدّ. مقصود في بيئة العرض والاختبار؛ في الإنتاج تقرير البيئة يكشف غياب المزوّد. يُعرض على المالك إن أراد حفظها بدل إسقاطها.
+- `notification-provider.ts`: Resend يقبل ترويسة `Idempotency-Key`؛ إرسال معرّف الصفّ فيها يجعل أيّ إرسال مكرّر بلا أثر عند المزوّد نفسه — طبقة ثانية خلف ت-٢. يحتاج تمرير المعرّف إلى المزوّد (تحسين لاحق).
+- `notification-outbox.service.ts`: «ابتلاع» P2002 داخل معاملة لا يُنقذها في Postgres (الخطأ يُفسد المعاملة كلّها). لا يُبلَغ عمليّاً: فحص نسخة الطلب يسبق الإدراج فيُسلسل الانتقالات المتزامنة. يُترك كما هو مع هذه الملاحظة.
 - `resend-webhook.ts`: الشكوى تُنسب إلى آخر متجر أرسل لهذا العنوان، لأنّ معرّف الرسالة عند المزوّد لا يُحفظ عند الإرسال. زبون يشتري من متجرين ويشكو أحدهما قد تُنسب شكواه إلى الآخر. الحلّ يحتاج عموداً جديداً (معرّف الرسالة عند الإرسال) — يُعرض على المالك.
```

</details>

## eb7f1db — fix(notifications): asking «نبّهني» again on the same item earns a second alert (review batch 5, ت-٣)

التاريخ: 2026-11-22

> The back-in-stock dedupe key was `back_in_stock:{wishlist row}` — fixed for
> the row's life. Pressing «نبّهني» again on an item already in the list
> updates that same row, so the second alert collided with the first, the
> transaction rolled back, the request stayed standing, and the scanner tried
> again every ten minutes for ever without sending anything.
> One key per ask: `back_in_stock:{row}:{n}`, after the largest key still in
> the outbox (the first alert's legacy key, with no suffix, counts as 0). Two
> scanners racing on the same ask compute the same key, so the unique index
> still makes it one message.
> cd2: a re-ask on the same row — 0 enqueued and a «duplicate» before; one
> alert and the request retired after (three runs).
> Also reads messaging-compliance and the abandoned-cart scanner in full.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | عُدّل | 9 | 3 | 16 ← 16، 22 ← 22، 29 ← 29، — ← 56–59، — ← 61–62 |
| `phase1-backend/src/notifications/restock-scanner.ts` | عُدّل | 29 | 1 | — ← 47–73، — ← 131، 111 ← 139 |
| `phase1-backend/tests/cd2.integration.mjs` | عُدّل | 38 | 0 | — ← 748–785 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/docs/review/batch-05-infra.md b/docs/review/batch-05-infra.md
index 4eb5932..fdb812b 100644
--- a/docs/review/batch-05-infra.md
+++ b/docs/review/batch-05-infra.md
@@ -15,3 +15,3 @@
 | `phase1-backend/src/services/soft-delete/purge-job.ts` | 349 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/messaging-compliance.service.ts` | 336 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/messaging-compliance.service.ts` | 336 | 2026-11-22 (كاملاً) | رابط إلغاء الاشتراك موقَّع ويُتحقَّق منه بزمن ثابت مع مفتاح سابق للتدوير؛ النوع المجهول يُعامَل تسويقاً (الأحوط)؛ الحدود يوميّة. ملاحظة أدناه |
 | `server/index.ts` | 322 | — | لم يُقرأ |
@@ -21,3 +21,3 @@
 | `phase1-backend/src/notifications/trial-expiry-scanner.ts` | 219 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | 218 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | 218 | 2026-11-22 (كاملاً) | المتاجر المفعّلة فقط، وكلّ سلّة تُختم في معاملة الإدراج نفسها. ملاحظة أدناه |
 | `phase1-backend/src/notifications/worker-entry.ts` | 212 | 2026-11-22 (كاملاً) | عامل الإشعارات والمهامّ المجدولة؛ في الإنتاج نسختان كلّ منهما بعاملها — المهامّ ليست مقفلة بين العمليّتين، لكنّ تكرار رسائلها يمنعه فهرس `dedupe` الفريد (بمتجر وبلا متجر) |
@@ -28,3 +28,3 @@
 | `phase1-backend/src/demo/demo-mode.ts` | 150 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/restock-scanner.ts` | 139 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/restock-scanner.ts` | 139 | 2026-11-22 (كاملاً) | ت-٣. المرشّحون يُصفّون في الاستعلام (المتجر مفعّل، الزبون ببريد) فلا يتراكمون |
 | `phase1-backend/src/logging/redact.ts` | 133 | — | لم يُقرأ |
@@ -55,3 +55,9 @@
 
+### [ت-٣] «نبّهني» ثانيةً على المنتج نفسه لا يصل أبداً — تحسين
+- المكان: `restock-scanner.ts`. مفتاح منع التكرار كان `back_in_stock:{صفّ قائمة الرغبات}` — ثابتاً طول عمر الصفّ. الضغط على «نبّهني» ثانيةً لمنتج في القائمة يحدّث الصفّ نفسه، فيصطدم التنبيه الثاني بالأوّل، وتتراجع المعاملة، ويبقى الطلب قائماً، ويُعاد كلّ عشر دقائق إلى الأبد دون أن يُرسل شيء.
+- الحالة: **مُصلَح** — مفتاح لكلّ طلب: `back_in_stock:{الصفّ}:{n}` بعد أكبر مفتاح باقٍ (مفتاح التنبيه الأوّل القديم بلا رقم = ٠)؛ ماسحان متزامنان يحسبان المفتاح نفسه فيبقى التنبيه واحداً. الاختبار (`cd2`): إعادة الطلب على الصفّ نفسه — ٠ تنبيه و«مكرّر» قبل؛ تنبيه واحد والطلب يُطوى بعد (ثلاث مرّات).
+
 ### ملاحظات
+- `abandoned-cart-scanner.ts`: زبون حظره التاجر يصله «سلّتك بانتظارك» (لا يُفحص `isActive`)؛ وقسيمة الاسترداد تُفحص «مفعّلة» لا «سارية» — قد تُعرض قسيمة انتهت فيرفضها الدفع. أثرهما صغير؛ يُعرضان على المالك.
+- `messaging-compliance.service.ts`: حدود المستلم تُقارن العنوان كما خُزّن لا موحَّداً — عنوان بحروف كبيرة وصغيرة مختلفة يُعدّ اثنين. العناوين تُوحَّد عند التسجيل، فالأثر ضئيل.
 - بلا مزوّد بريد مُعَدّ تُعلَّم الرسائل «skipped» نهائيّاً (`no_provider_configured`) — لا تُحفظ لتُرسل حين يُعَدّ. مقصود في بيئة العرض والاختبار؛ في الإنتاج تقرير البيئة يكشف غياب المزوّد. يُعرض على المالك إن أراد حفظها بدل إسقاطها.
diff --git a/phase1-backend/src/notifications/restock-scanner.ts b/phase1-backend/src/notifications/restock-scanner.ts
index 0defc52..f51da2e 100644
--- a/phase1-backend/src/notifications/restock-scanner.ts
+++ b/phase1-backend/src/notifications/restock-scanner.ts
@@ -46,2 +46,29 @@ export interface RestockScanResult {
 
+/**
+ * Review batch 5, ت-٣ — one key per ASK, not per wishlist row. «نبّهني» pressed again on an item
+ * already in the list updates the same row; a key of the row's id alone collided with the first
+ * alert, rolled the transaction back, left the request standing and retried it every pass for
+ * ever. The n-th alert for a row is `back_in_stock:{row}:{n}` — after the largest key that still
+ * exists (the first alert's legacy key has no suffix and counts as 0). Two scanners racing on the
+ * same ask compute the same key, so the unique index still makes it one message.
+ */
+async function nextRestockKey(
+  tx: Prisma.TransactionClient,
+  storeId: string,
+  itemId: string
+): Promise<string> {
+  const base = `back_in_stock:${itemId}`;
+  const earlier = await tx.notificationOutbox.findMany({
+    where: { storeId, dedupeKey: { startsWith: base } },
+    select: { dedupeKey: true },
+  });
+  if (!earlier.length) return base;
+  const last = Math.max(
+    ...earlier.map((row) =>
+      row.dedupeKey === base ? 0 : Number(row.dedupeKey!.slice(base.length + 1)) || 0
+    )
+  );
+  return `${base}:${last + 1}`;
+}
+
 export async function scanRestocks(): Promise<RestockScanResult> {
@@ -103,2 +130,3 @@ export async function scanRestocks(): Promise<RestockScanResult> {
         await prisma.$transaction(async (tx) => {
+          const dedupeKey = await nextRestockKey(tx, item.storeId, item.id);
           await tx.notificationOutbox.create({
@@ -110,3 +138,3 @@ export async function scanRestocks(): Promise<RestockScanResult> {
               recipient: item.customer.email!,
-              dedupeKey: `back_in_stock:${item.id}`,
+              dedupeKey,
               payload: {
diff --git a/phase1-backend/tests/cd2.integration.mjs b/phase1-backend/tests/cd2.integration.mjs
index fc6fc09..764bb98 100644
--- a/phase1-backend/tests/cd2.integration.mjs
+++ b/phase1-backend/tests/cd2.integration.mjs
@@ -747,2 +747,40 @@ try {
 
+  // Review batch 5, ت-٣: he asks again on the SAME row («نبّهني» pressed on an item already in
+  // his list, which updates it). The key was the row's id alone, so the second alert collided
+  // with the first, the transaction rolled back, the flag stayed on — and every pass tried
+  // again for ever, sending nothing.
+  await prisma.productVariant.update({
+    where: { id: shoes.variant.id },
+    data: { stockQuantity: 0 },
+  });
+  const askedAgain = await request(wishPath, {
+    method: "POST",
+    token: buyer.token,
+    body: { variantId: shoes.variant.id, notifyOnRestock: true },
+  });
+  assert.ok([200, 201].includes(askedAgain.status), JSON.stringify(askedAgain.payload));
+  await prisma.productVariant.update({
+    where: { id: shoes.variant.id },
+    data: { stockQuantity: 7 },
+  });
+  const sameRowAgain = await scanRestocks();
+  assert.equal(
+    sameRowAgain.enqueued,
+    1,
+    `a second ask on the same row earns a second alert · ${JSON.stringify(sameRowAgain)}`
+  );
+  assert.equal(
+    (
+      await prisma.wishlistItem.findFirstOrThrow({
+        where: { storeId: storeA.id, customerId: buyer.id, variantId: shoes.variant.id },
+      })
+    ).notifyOnRestock,
+    false,
+    "…and the request is retired, not left to retry for ever"
+  );
+  await prisma.notificationOutbox.deleteMany({
+    where: { storeId: storeA.id, eventType: "stock.back_in_stock" },
+  });
+  await prisma.notificationOutbox.create({ data: { ...alert, id: undefined } });
+
   // And he may ask AGAIN. This is what keying on the wishlist row buys: a
```

</details>

## ba98df5 — fix(notifications): the status mail speaks Arabic, not database codes (review batch 5, ت-٤)

التاريخ: 2026-11-22

> The order-status mail reached shoppers and merchants as «تغيرت حالة الطلب …
> من processing إلى out_for_delivery». Both statuses now read in the shopper's
> words («قيد التجهيز»، «في الطريق إليك»…), from one map moved out of the
> market's «طلباتي» into services/order-status-labels.ts and read by both — so
> the duplicate-code count goes down, not up. An unknown code prints as it is.
> phase15: the codes in the text before; Arabic and no code after (twice). cd1,
> cd3, cd5 and market:orders pass.
> Also reads the trial-expiry and merchant-digest scanners in full.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | عُدّل | 7 | 2 | 21 ← 21، 25 ← 25، — ← 60–63، — ← 65 |
| `phase1-backend/src/modules/market-cart/checkout/orders.ts` | عُدّل | 4 | 14 | — ← 5، 20–30 ← —، 77 ← 67، 148 ← 138، 154 ← 144 |
| `phase1-backend/src/notifications/outbox/render.ts` | عُدّل | 8 | 1 | — ← 6، — ← 31–36، 60 ← 67 |
| `phase1-backend/src/services/order-status-labels.ts` | أُضيف | 15 | 0 | — ← 1–15 |
| `phase1-backend/tests/phase15.notifications.integration.ts` | عُدّل | 22 | 0 | — ← 21، — ← 610–630 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/docs/review/batch-05-infra.md b/docs/review/batch-05-infra.md
index fdb812b..ee0a4cc 100644
--- a/docs/review/batch-05-infra.md
+++ b/docs/review/batch-05-infra.md
@@ -20,3 +20,3 @@
 | `phase1-backend/src/services/retention-job.ts` | 220 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/trial-expiry-scanner.ts` | 219 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/trial-expiry-scanner.ts` | 219 | 2026-11-22 (كاملاً) | إنهاء التجربة بتحديث مشروط ونقلٌ للخطّة المجانيّة في المعاملة نفسها؛ التذكير بمفتاح فريد ودون متجر. ملاحظة أدناه |
 | `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | 218 | 2026-11-22 (كاملاً) | المتاجر المفعّلة فقط، وكلّ سلّة تُختم في معاملة الإدراج نفسها. ملاحظة أدناه |
@@ -24,3 +24,3 @@
 | `phase1-backend/src/services/reservation-expiry-job.ts` | 203 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/merchant-digest-scanner.ts` | 180 | — | لم يُقرأ |
+| `phase1-backend/src/notifications/merchant-digest-scanner.ts` | 180 | 2026-11-22 (كاملاً) | يوم بغداد؛ لا ملخّص حين لا شيء يُقال؛ واحد في اليوم بمفتاح فريد |
 | `phase1-backend/src/notifications/resend-webhook.ts` | 164 | 2026-11-22 (كاملاً) | التوقيع بنمط Svix بنافذة ٥ دقائق ومقارنة ثابتة الزمن، والحدث يُسجَّل مرّة؛ الشكوى تُنسب لمتجر أرسل فعلاً. ملاحظة أدناه |
@@ -59,3 +59,8 @@
 
+### [ت-٤] بريد تغيّر الحالة يطبع رموز القاعدة بالإنكليزيّة — تحسين
+- المكان: `notifications/outbox/render.ts`. يصل الزبونَ والتاجرَ «تغيرت حالة الطلب … من processing إلى out_for_delivery».
+- الحالة: **مُصلَح** — الحالتان بكلمات الزبون («قيد التجهيز»، «في الطريق إليك»…) من خريطة واحدة نُقلت من «طلباتي» في السوق إلى `services/order-status-labels.ts` ويقرؤها الاثنان (فقلّ التكرار بدل أن يزيد)؛ رمز مجهول يبقى كما هو. الاختبار (`phase15`): الرموز في النصّ قبل؛ العربيّة ولا رمز بعد (مرّتان).
+
 ### ملاحظات
+- `trial-expiry-scanner.ts`: الحلقة تعيد القراءة من البداية في كلّ دورة؛ اشتراك تفشل معاملته باستمرار يبقى «فعّالاً» ويُقرأ ثانيةً. لو بلغت هذه الصفوف ٢٠٠ لما انتهت الحلقة، ولأنّ المهامّ متتالية لتوقّفت معها كلّ المهامّ المجدولة. نادر جدّاً (الخطّة المجانيّة المفقودة تُفحص قبل الحلقة)؛ يُترك ملاحظةً.
 - `abandoned-cart-scanner.ts`: زبون حظره التاجر يصله «سلّتك بانتظارك» (لا يُفحص `isActive`)؛ وقسيمة الاسترداد تُفحص «مفعّلة» لا «سارية» — قد تُعرض قسيمة انتهت فيرفضها الدفع. أثرهما صغير؛ يُعرضان على المالك.
diff --git a/phase1-backend/src/modules/market-cart/checkout/orders.ts b/phase1-backend/src/modules/market-cart/checkout/orders.ts
index 951c501..5d74df1 100644
--- a/phase1-backend/src/modules/market-cart/checkout/orders.ts
+++ b/phase1-backend/src/modules/market-cart/checkout/orders.ts
@@ -4,2 +4,3 @@
  */
+import { ORDER_STATUS_LABELS_AR } from "../../../services/order-status-labels.js";
 import {
@@ -19,13 +20,2 @@ const ORDERS_KIND = "market-shopper-orders";
 
-const STATUS_LABELS: Record<string, string> = {
-  new: "قيد المراجعة",
-  processing: "تم القبول",
-  preparation: "قيد التجهيز",
-  out_for_delivery: "في الطريق إليك",
-  completed: "تم التسليم",
-  cancelled: "ملغي",
-  rejected: "مرفوض",
-  returned: "مُرجع",
-};
-
 /** Every order the shopper placed, across every store, newest first. */
@@ -76,3 +66,3 @@ export async function shopperOrders(
       status: row.status,
-      statusLabel: STATUS_LABELS[row.status] ?? row.status,
+      statusLabel: ORDER_STATUS_LABELS_AR[row.status] ?? row.status,
       fulfilment: row.fulfilment,
@@ -147,3 +137,3 @@ export async function shopperOrder(shopperId: string, orderId: string) {
       ...shown,
-      statusLabel: STATUS_LABELS[order.status] ?? order.status,
+      statusLabel: ORDER_STATUS_LABELS_AR[order.status] ?? order.status,
       governorateName: order.shippingGovernorate
@@ -153,3 +143,3 @@ export async function shopperOrder(shopperId: string, orderId: string) {
         status: event.toStatus,
-        label: STATUS_LABELS[event.toStatus] ?? event.toStatus,
+        label: ORDER_STATUS_LABELS_AR[event.toStatus] ?? event.toStatus,
         at: event.createdAt,
diff --git a/phase1-backend/src/notifications/outbox/render.ts b/phase1-backend/src/notifications/outbox/render.ts
index be34fe3..6481015 100644
--- a/phase1-backend/src/notifications/outbox/render.ts
+++ b/phase1-backend/src/notifications/outbox/render.ts
@@ -5,2 +5,3 @@
 import { publicUrl } from "../messaging-compliance.service.js";
+import { ORDER_STATUS_LABELS_AR } from "../../services/order-status-labels.js";
 import { courierDispatchedMessage } from "../courier-message.js";
@@ -29,2 +30,8 @@ interface RenderedMessage {
  */
+// Review batch 5, ت-٤: the shopper's words, not the database codes.
+function statusLabel(code: unknown): string {
+  const text = String(code ?? "");
+  return ORDER_STATUS_LABELS_AR[text] ?? text;
+}
+
 function linkLine(prefix: string, relativePath: unknown): string {
@@ -59,3 +66,3 @@ export function renderMessage(row: {
       subject: `تحديث حالة الطلب ${orderNumber}`,
-      body: `تغيرت حالة الطلب ${orderNumber} في ${storeName} من ${String(payload.fromStatus ?? "")} إلى ${String(payload.toStatus ?? "")}.`,
+      body: `تغيرت حالة الطلب ${orderNumber} في ${storeName} من ${statusLabel(payload.fromStatus)} إلى ${statusLabel(payload.toStatus)}.`,
     };
diff --git a/phase1-backend/src/services/order-status-labels.ts b/phase1-backend/src/services/order-status-labels.ts
new file mode 100644
index 0000000..4f7819e
--- /dev/null
+++ b/phase1-backend/src/services/order-status-labels.ts
@@ -0,0 +1,15 @@
+/**
+ * An order's status in the shopper's words — one map for every server surface that shows it: the
+ * market's «طلباتي» (moved here from market-cart/checkout/orders.ts) and the status mail (review
+ * batch 5, ت-٤), which used to print the database codes («من processing إلى out_for_delivery»).
+ */
+export const ORDER_STATUS_LABELS_AR: Record<string, string> = {
+  new: "قيد المراجعة",
+  processing: "تم القبول",
+  preparation: "قيد التجهيز",
+  out_for_delivery: "في الطريق إليك",
+  completed: "تم التسليم",
+  cancelled: "ملغي",
+  rejected: "مرفوض",
+  returned: "مُرجع",
+};
diff --git a/phase1-backend/tests/phase15.notifications.integration.ts b/phase1-backend/tests/phase15.notifications.integration.ts
index 3d44cf5..d3e01bf 100644
--- a/phase1-backend/tests/phase15.notifications.integration.ts
+++ b/phase1-backend/tests/phase15.notifications.integration.ts
@@ -20,2 +20,3 @@ import {
   STALE_CLAIM_RECOVERY_MS,
+  renderMessage,
 } from "../src/notifications/outbox-worker.js";
@@ -608,2 +609,23 @@ try {
 
+  // Review batch 5, ت-٤: the status mail is read by a shopper — in Arabic, not in the codes the
+  // database stores («من processing إلى out_for_delivery»).
+  const statusMail = renderMessage({
+    eventType: "order.status_changed",
+    recipientKind: "customer",
+    payload: {
+      orderNumber: "SF-1",
+      fromStatus: "preparation",
+      toStatus: "out_for_delivery",
+      storeName: "متجر",
+    },
+  });
+  assert.ok(
+    statusMail.body.includes("قيد التجهيز") && statusMail.body.includes("في الطريق إليك"),
+    statusMail.body
+  );
+  assert.ok(
+    !/[a-z_]{4,}/.test(statusMail.body),
+    `no status code left in the text · ${statusMail.body}`
+  );
+
   // Review batch 5, ت-٢: a batch that outlives the stale-claim window. Production runs two
```

</details>

## 9bf40da — docs(review): batch 5 — every file read

التاريخ: 2026-11-22

> The remaining 24 files read in full: configuration and the environment report,
> backups (envelope, storage, policy), logging and redaction, Sentry, domain
> events, the demo guard, the database helpers, retention, reservation expiry,
> the trash purger, the courier and maintenance messages, and both server
> entries. Nothing further to fix; notes recorded for the backup decryption
> order, the purger stopping on a non-FK error, and Sentry's release variable.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/batch-05-infra.md` | عُدّل | 26 | 24 | 10–11 ← 10–11، 13 ← 13، 15 ← 15، 17–20 ← 17–20، 24 ← 24، 27–28 ← 27–28، 30 ← 30، 32–43 ← 32–43، — ← 65–66 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/docs/review/batch-05-infra.md b/docs/review/batch-05-infra.md
index ee0a4cc..a875b87 100644
--- a/docs/review/batch-05-infra.md
+++ b/docs/review/batch-05-infra.md
@@ -9,13 +9,13 @@
 | `phase1-backend/src/notifications/outbox-worker.ts` | 802 | 2026-11-22 (كاملاً) | ت-١ (قُسّم ← outbox/{render,batch,loop}.ts). batch: ت-٢. الترتيب بالأولويّة ثمّ الموعد؛ بوّابات الحدود وإلغاء الاشتراك قبل المزوّد؛ إعادة المحاولة أسّيّة ثمّ dead_letter. ملاحظات أدناه |
-| `phase1-backend/src/services/config.service.ts` | 582 | — | لم يُقرأ |
-| `phase1-backend/src/config/environment-report.ts` | 423 | — | لم يُقرأ |
+| `phase1-backend/src/services/config.service.ts` | 582 | 2026-11-22 (كاملاً) | سجلّ إعدادات مغلق؛ «سقف» يأخذ الأصغر، و«سماح» يُرفض إن رفضه أيّ مستوى؛ التاجر لا يتجاوز سقف المنصّة والخطّة، وتغيير المنصّة بسجلّ تدقيق |
+| `phase1-backend/src/config/environment-report.ts` | 423 | 2026-11-22 (كاملاً) | تقرير الجاهزيّة: ما ينقص الإنتاج، والمفاتيح القصيرة، ومفاتيح الاختبار المتروكة، واتّصال القاعدة بلا TLS؛ بيئة بلا NODE_ENV تُعامَل منشورة |
 | `phase1-backend/src/notifications/notification-provider.ts` | 401 | 2026-11-22 (كاملاً) | Resend عبر HTTP بمهلة ٢٠ ثانية و`redirect: error`؛ SMTP بعنوان IPv4 مع `servername`. ملاحظات أدناه |
-| `phase1-backend/src/backup/backup-envelope.ts` | 393 | — | لم يُقرأ |
+| `phase1-backend/src/backup/backup-envelope.ts` | 393 | 2026-11-22 (كاملاً) | AES-256-GCM بإطارات، والترويسة والرقم و«الأخير» داخل البيانات الموثَّقة — القطع والترتيب والتلاعب تُكشف؛ تدوير المفتاح. ملاحظة أدناه |
 | `phase1-backend/src/notifications/notification-outbox.service.ts` | 353 | 2026-11-22 (كاملاً) | كلّ صفّ يُكتب في معاملة الحدث نفسه؛ إشعار تغيّر الحالة لا يُرسل للتاجر عمّا فعله هو. ملاحظة أدناه |
-| `phase1-backend/src/services/soft-delete/purge-job.ts` | 349 | — | لم يُقرأ |
+| `phase1-backend/src/services/soft-delete/purge-job.ts` | 349 | 2026-11-22 (كاملاً) | الحذف النهائيّ مشروط (ما زال محذوفاً وتجاوز المدّة) وبسجلّ تدقيق؛ الصور تُحذف بعد الالتزام؛ المحجوب بمفتاح أجنبيّ يُختم بسببه. ملاحظة أدناه |
 | `phase1-backend/src/notifications/messaging-compliance.service.ts` | 336 | 2026-11-22 (كاملاً) | رابط إلغاء الاشتراك موقَّع ويُتحقَّق منه بزمن ثابت مع مفتاح سابق للتدوير؛ النوع المجهول يُعامَل تسويقاً (الأحوط)؛ الحدود يوميّة. ملاحظة أدناه |
-| `server/index.ts` | 322 | — | لم يُقرأ |
-| `phase1-backend/src/backup/backup-storage.ts` | 314 | — | لم يُقرأ |
-| `phase1-backend/src/logging/logger.ts` | 252 | — | لم يُقرأ |
-| `phase1-backend/src/services/retention-job.ts` | 220 | — | لم يُقرأ |
+| `server/index.ts` | 322 | 2026-11-22 (كاملاً) | العامل عمليّة مستقلّة يُعاد تشغيلها بتراجع أسّيّ؛ HTTPS فقط ورؤوس الأمان قبل كلّ شيء؛ الملفّات الثابتة بتخزين طويل للأصول فقط؛ مسار شكله ملفّ أو يبدأ بنقطة ← ٤٠٤ |
+| `phase1-backend/src/backup/backup-storage.ts` | 314 | 2026-11-22 (كاملاً) | لا ينتقل للحاوية المشتركة إن كانت المخصّصة ناقصة؛ النصّ المشفّر وحده يُكتب مؤقّتاً؛ الحذف يُرفض خارج البادئة؛ ١٤ نسخة على الأقلّ تبقى |
+| `phase1-backend/src/logging/logger.ts` | 252 | 2026-11-22 (كاملاً) | كلّ حقل وسياق يُقنَّع بالمفتاح والنصّ، بحدود للعمق والطول والسطر؛ فشل التسلسل لا يُسقط السجلّ |
+| `phase1-backend/src/services/retention-job.ts` | 220 | 2026-11-22 (كاملاً) | حذف بدفعات محدودة لكلّ جدول؛ فشل جدول لا يوقف غيره. حذف الرسائل المرسلة بعد ٩٠ يوماً لا يعيد فتح مفتاح تكرار يهمّ |
 | `phase1-backend/src/notifications/trial-expiry-scanner.ts` | 219 | 2026-11-22 (كاملاً) | إنهاء التجربة بتحديث مشروط ونقلٌ للخطّة المجانيّة في المعاملة نفسها؛ التذكير بمفتاح فريد ودون متجر. ملاحظة أدناه |
@@ -23,22 +23,22 @@
 | `phase1-backend/src/notifications/worker-entry.ts` | 212 | 2026-11-22 (كاملاً) | عامل الإشعارات والمهامّ المجدولة؛ في الإنتاج نسختان كلّ منهما بعاملها — المهامّ ليست مقفلة بين العمليّتين، لكنّ تكرار رسائلها يمنعه فهرس `dedupe` الفريد (بمتجر وبلا متجر) |
-| `phase1-backend/src/services/reservation-expiry-job.ts` | 203 | — | لم يُقرأ |
+| `phase1-backend/src/services/reservation-expiry-job.ts` | 203 | 2026-11-22 (كاملاً) | تحرير الحجز قلب حالة فقط — المخزون لم يُخصم أصلاً قبل الاكتمال؛ قفل الطلب أوّلاً، وتحديث مشروط يجعله مرّة واحدة |
 | `phase1-backend/src/notifications/merchant-digest-scanner.ts` | 180 | 2026-11-22 (كاملاً) | يوم بغداد؛ لا ملخّص حين لا شيء يُقال؛ واحد في اليوم بمفتاح فريد |
 | `phase1-backend/src/notifications/resend-webhook.ts` | 164 | 2026-11-22 (كاملاً) | التوقيع بنمط Svix بنافذة ٥ دقائق ومقارنة ثابتة الزمن، والحدث يُسجَّل مرّة؛ الشكوى تُنسب لمتجر أرسل فعلاً. ملاحظة أدناه |
-| `phase1-backend/src/observability/sentry.ts` | 154 | — | لم يُقرأ |
-| `phase1-backend/src/demo/demo-mode.ts` | 150 | — | لم يُقرأ |
+| `phase1-backend/src/observability/sentry.ts` | 154 | 2026-11-22 (كاملاً) | لا PII ولا جسم ولا كوكيز ولا ترويسات؛ أخطاء ٤xx لا تُرسل. ملاحظة: `release` يقرأ `RAILWAY_GIT_COMMIT_SHA` والنشر على Cloudflare |
+| `phase1-backend/src/demo/demo-mode.ts` | 150 | 2026-11-22 (كاملاً) | بيئة العرض تحجب مسارات المنصّة والتسجيل، وتحمي متجر العرض وحساباته من التعديل |
 | `phase1-backend/src/notifications/restock-scanner.ts` | 139 | 2026-11-22 (كاملاً) | ت-٣. المرشّحون يُصفّون في الاستعلام (المتجر مفعّل، الزبون ببريد) فلا يتراكمون |
-| `phase1-backend/src/logging/redact.ts` | 133 | — | لم يُقرأ |
+| `phase1-backend/src/logging/redact.ts` | 133 | 2026-11-22 (كاملاً) | تقنيع JWT والأسرار المختومة وBearer والبريد والهاتف؛ المفاتيح الحسّاسة بالاسم |
 | `phase1-backend/src/jobs/scheduler.ts` | 127 | 2026-11-22 (كاملاً) | نبضة واحدة كلّ ٣٠ دقيقة والمهامّ متتالية فيها (لكي يغفو Neon)؛ لا تداخل داخل العمليّة، وفشل مهمّة لا يمنع غيرها |
-| `phase1-backend/src/events/domain-events.ts` | 112 | — | لم يُقرأ |
-| `phase1-backend/src/services/retention.ts` | 110 | — | لم يُقرأ |
-| `phase1-backend/src/config.ts` | 107 | — | لم يُقرأ |
-| `phase1-backend/src/backup/backup-policy.ts` | 100 | — | لم يُقرأ |
-| `phase1-backend/src/logging/context.ts` | 87 | — | لم يُقرأ |
-| `phase1-backend/src/db/serializable-retry.ts` | 73 | — | لم يُقرأ |
-| `phase1-backend/src/db/database-url.ts` | 70 | — | لم يُقرأ |
-| `phase1-backend/src/jobs/outbox-signal.ts` | 65 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/maintenance-message.ts` | 50 | — | لم يُقرأ |
-| `phase1-backend/src/notifications/courier-message.ts` | 26 | — | لم يُقرأ |
-| `phase1-backend/src/index.ts` | 17 | — | لم يُقرأ |
-| `phase1-backend/src/db/prisma.ts` | 7 | — | لم يُقرأ |
+| `phase1-backend/src/events/domain-events.ts` | 112 | 2026-11-22 (كاملاً) | الأحداث بعد الالتزام، كلّ معالج مستقلّ وفشله لا يمسّ غيره؛ `drain` عند الإيقاف |
+| `phase1-backend/src/services/retention.ts` | 110 | 2026-11-22 (كاملاً) | مُدد الحفظ، وما لا يُحذف آليّاً أبداً (الدفاتر والتدقيق والمخزون) |
+| `phase1-backend/src/config.ts` | 107 | 2026-11-22 (كاملاً) | الإعداد عند الإقلاع؛ مفتاح الجلسة القصير تحذير هنا وعدم جاهزيّة في التقرير |
+| `phase1-backend/src/backup/backup-policy.ts` | 100 | 2026-11-22 (كاملاً) | كلّ ٦ ساعات، ٣٠ يوماً، ١٤ نسخة على الأقلّ |
+| `phase1-backend/src/logging/context.ts` | 87 | 2026-11-22 (كاملاً) | معرّف طلب لكلّ طلب ولكلّ مرور مهمّة (AsyncLocalStorage) |
+| `phase1-backend/src/db/serializable-retry.ts` | 73 | 2026-11-22 (كاملاً) | إعادة المحاولة للتعارض والمهلة — و P2002 أيضاً (لسباق مفتاح عدم التكرار في الدفع) |
+| `phase1-backend/src/db/database-url.ts` | 70 | 2026-11-22 (كاملاً) | رابط PostgreSQL فقط؛ الهجرات على الاتّصال غير المجمَّع |
+| `phase1-backend/src/jobs/outbox-signal.ts` | 65 | 2026-11-22 (كاملاً) | إيقاظ العامل عبر IPC بلا قاعدة؛ الفشل صامت عن قصد |
+| `phase1-backend/src/notifications/maintenance-message.ts` | 50 | 2026-11-22 (كاملاً) | رسائل الصيانة الثلاث (نُقلت من العامل بعد إغلاق الدفعة ٤) |
+| `phase1-backend/src/notifications/courier-message.ts` | 26 | 2026-11-22 (كاملاً) | رسالة المندوب بالنقد المتبقّي (م-٣ من الدفعة ٤) |
+| `phase1-backend/src/index.ts` | 17 | 2026-11-22 (كاملاً) | خادم الواجهة البرمجيّة وحده للتطوير |
+| `phase1-backend/src/db/prisma.ts` | 7 | 2026-11-22 (كاملاً) | عميل Prisma واحد |
 
@@ -64,2 +64,4 @@
 ### ملاحظات
+- `backup-envelope.ts`: فكّ التشفير يُخرج الإطارات قبل أن يتحقّق من علامة النهاية — ملفّ مقطوع يُكتشف في آخره، بعد أن يكون جزء منه قد خرج. أداة الاستعادة يجب أن تفكّ إلى ملفّ أوّلاً ثمّ تستعيد.
+- `purge-job.ts`: في المرور الأوّل، خطأ غير «مفتاح أجنبيّ» يوقف المرور كلّه؛ صفّ يفشل بسبب آخر دائماً يُقرأ أوّلاً كلّ مرّة فيوقف الحذف النهائيّ للجميع. نادر؛ يُترك ملاحظةً.
 - `trial-expiry-scanner.ts`: الحلقة تعيد القراءة من البداية في كلّ دورة؛ اشتراك تفشل معاملته باستمرار يبقى «فعّالاً» ويُقرأ ثانيةً. لو بلغت هذه الصفوف ٢٠٠ لما انتهت الحلقة، ولأنّ المهامّ متتالية لتوقّفت معها كلّ المهامّ المجدولة. نادر جدّاً (الخطّة المجانيّة المفقودة تُفحص قبل الحلقة)؛ يُترك ملاحظةً.
```

</details>

## cc09260 — review batch 5: lower the duplicate-code baseline

التاريخ: 2026-11-22

> The shared order-status map (ت-٤) removed a duplicated block: 7,950
> duplicated lines in 571 blocks (5.50%). Lowering only.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `tools/duplicate-baseline.json` | عُدّل | 3 | 4 | 4–6 ← 4–6، 122 ← — |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/tools/duplicate-baseline.json b/tools/duplicate-baseline.json
index 2707942..b12c616 100644
--- a/tools/duplicate-baseline.json
+++ b/tools/duplicate-baseline.json
@@ -3,5 +3,5 @@
  "counts": {
-  "duplicatedLines": 7968,
-  "blocks": 573,
-  "percent": 5.51
+  "duplicatedLines": 7950,
+  "blocks": 571,
+  "percent": 5.5
  },
@@ -121,3 +121,2 @@
   "phase1-backend/src/notifications/notification-outbox.service.ts": 20,
-  "phase1-backend/src/notifications/outbox/batch.ts": 18,
   "phase1-backend/src/services/analytics.service.ts": 23,
```

</details>

