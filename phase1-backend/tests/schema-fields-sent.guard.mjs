/**
 * ق-168 — a field the server's schema accepts is a field some screen can send.
 *
 * ============================================================================
 * THE THIRD FACE OF ONE DEFECT
 * ============================================================================
 *
 * Today produced three variants of the same failure, and this guards the third:
 *
 *   ق-163  the client DECLARED a field and did not send it        (checkout)
 *   ق-167  the server WROTE a column and no list query read it    (ownerName)
 *   ق-168  the server ACCEPTS a field and no screen offers it     (this)
 *
 * `resolveReturnInspectionSchema` has accepted `note` since RI-1. The service
 * trims it, bounds it, and stores it in the audit trio the ledger promised —
 * «مَن ومتى وملاحظة». The card sent `{ restockQty, writeOffQty }` and had no
 * field for it at all.
 *
 * So a merchant wrote off damaged stock — money gone — and could not record
 * why. A month later nobody can answer the only question that matters about it.
 *
 * ============================================================================
 * WHAT IS ASSERTED
 * ============================================================================
 *
 * For each registered schema field: the field name appears in the client screen
 * that posts to that route. This is a string check, not a runtime one — it
 * cannot prove the value is correct, only that the screen knows the field
 * exists. That is enough: the defect being guarded is a field NOTHING sends,
 * and the ق-163 guard covers the case where a client declares and drops.
 *
 * A REGISTRY, not a scan. Many optional fields are correctly absent from a
 * screen — an integrator-facing API field, a value only another service sends.
 * So entries are added by hand, with the reason a human needs it.
 *
 * Run: pnpm schema:sent
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

const REGISTERED = [
  {
    field: "note",
    schema: "phase1-backend/src/http/schemas/return-inspection.schema.ts",
    screen: "client/src/components/ReturnInspectionCard.tsx",
    why: "سبب إتلاف البضاعة — مالٌ ضائع لا يُسأل عنه إلا بعد شهر",
  },
  {
    field: "note",
    schema: "phase1-backend/src/http/schemas/storefront.schema.ts",
    screen: "client/src/pages/StorefrontCheckoutPage.tsx",
    why: "ملاحظة الزبون للمندوب — «اتصل قبل الوصول»",
  },
];

const broken = [];
for (const { field, schema, screen, why } of REGISTERED) {
  const schemaSource = read(schema);
  const screenSource = read(screen);
  // The schema must still accept it — if it was removed server-side, this entry
  // is stale and should be deleted rather than silently passing.
  if (!new RegExp(`\\b${field}:\\s*z\\.`).test(schemaSource)) {
    broken.push({ field, why, where: schema, note: "المخطط لم يعد يقبله — احذف السطر من السجل" });
    continue;
  }
  if (!new RegExp(`\\b${field}\\b`).test(screenSource)) {
    broken.push({ field, why, where: screen, note: "الشاشة لا تعرف الحقل" });
  }
}

assert.deepEqual(
  broken,
  [],
  `حقلٌ يقبله الخادم ولا ترسله شاشة:\n` +
    broken.map((b) => `  ${b.field} — ${b.why}\n      ${b.where}: ${b.note}`).join("\n") +
    `\n\nThe server has accepted these since they were written. A schema field with no screen behind it is a ` +
    `capability that exists and cannot be used — the shape this platform produced sixteen times over.`,
);

console.log(JSON.stringify({
  suite: "schema-fields-sent",
  status: "passed",
  summary: {
    registered: REGISTERED.map((entry) => `${entry.field} → ${entry.screen.split("/").pop()}`),
    guarantee: "every registered schema field is known to the screen that posts it",
  },
}, null, 2));
