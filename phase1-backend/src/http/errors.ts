import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { prescriptionImageConstraints, productImageConstraints, storeImageConstraints } from "../services/product-image-storage.service.js";
import { HttpError } from "../auth/auth.errors.js";
import { currentCorrelationId, currentLogContext, newCorrelationId } from "../logging/context.js";
import { logger } from "../logging/logger.js";
import { redactKey } from "../logging/redact.js";
import { reportServerFault } from "../observability/sentry.js";
import { CORRELATION_HEADER, routePatternOf } from "./correlation.js";
import { fkRuleFor, foreignKeyConstraintName, isForeignKeyViolation } from "../services/soft-delete/fk-violations.js";
import { isRetryableTransactionError } from "../db/serializable-retry.js";

/**
 * D-41 (phase 24-أ): the handler is now two halves.
 *
 * `classifyError` is the whole of the old function with `response.status(S)
 * .json(B)` rewritten as `return { status: S, error: B }`. Not one code and not
 * one Arabic message changed — phase 22 will translate them and the red team's
 * fixes name them, so they are a contract. Making it a pure function is what
 * lets the handler log EXACTLY ONE line per failure with the classification in
 * it, instead of a bare `console.error` at the bottom that fired only for the
 * errors nothing had mapped.
 */
interface ErrorOutcome {
  status: number;
  error: { code: string; message: string } & Record<string, unknown>;
  /** False only for the fallthrough 500: the fault the server owns and did not foresee. */
  mapped: boolean;
}

export function errorHandler(error: unknown, request: Request, response: Response, _next: NextFunction) {
  const requestId = ensureCorrelationId(response);
  const outcome = classifyError(error, request);
  logOutcome(error, request, outcome);
  // The envelope is byte-identical to the old one apart from `requestId`. That
  // one string is the point of the phase: a merchant who reports «صار خطأ» can
  // read it back, and it names the exact log line — no guessing from a
  // timestamp, and no asking him what he clicked.
  return response.status(outcome.status).json({ error: { ...outcome.error, requestId } });
}

function ensureCorrelationId(response: Response): string {
  const fromContext = currentCorrelationId();
  if (fromContext) {
    if (!response.headersSent) response.setHeader(CORRELATION_HEADER, fromContext);
    return fromContext;
  }
  const alreadySet = response.getHeader(CORRELATION_HEADER);
  if (typeof alreadySet === "string" && alreadySet.length > 0) return alreadySet;
  // Reached only if the edge middleware is not mounted — a bare `createApp()`
  // in a unit test, say. The body still carries an id rather than nothing.
  const generated = newCorrelationId();
  if (!response.headersSent) response.setHeader(CORRELATION_HEADER, generated);
  return generated;
}

/**
 * The route's own parameters — `:orderId`, `:storeSlug`, `:settlementId` — which
 * is how a money path names itself in the log WITHOUT a single edit to a route
 * handler.
 *
 * READ BACK OFF THE PATTERN, not off `request.params`. Express restores
 * `req.params` to the parent router's when a layer hands control on, so by the
 * time an error reaches an app-level handler the bag is empty — the trap this
 * function exists to survive. `req.route` is NOT restored, so the pattern is
 * still there, and the pattern plus `req.path` is the pair the ids come from.
 *
 * A denylist rather than an allowlist: a route added next month gets its ids in
 * the log automatically, while a `:token` segment is refused by the same rule
 * that governs every other context key.
 */
function safeParams(request: Request): Record<string, string> | undefined {
  const pattern = (request.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern !== "string" || !pattern.includes(":")) return undefined;
  const names = pattern.split("/");
  const values = request.path.split("/");
  // A regex or wildcard segment breaks the one-to-one alignment. There is no id
  // worth guessing at, so nothing is reported rather than something wrong.
  if (names.length !== values.length) return undefined;
  const output: Record<string, string> = {};
  let kept = 0;
  for (let index = 0; index < names.length && kept < 8; index += 1) {
    const name = names[index];
    if (!name.startsWith(":")) continue;
    const key = name.slice(1).replace(/[?*+(].*$/, "");
    const raw = values[index];
    if (!key || !raw) continue;
    if (redactKey(key)) { output[key] = "[redacted]"; kept += 1; continue; }
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep the raw segment */ }
    output[key] = value.slice(0, 64);
    kept += 1;
  }
  return kept > 0 ? output : undefined;
}

function logOutcome(error: unknown, request: Request, outcome: ErrorOutcome): void {
  const startedAt = currentLogContext()?.startedAt;
  const fields = {
    route: routePatternOf(request),
    method: request.method,
    status: outcome.status,
    code: outcome.error.code,
    params: safeParams(request),
    ...(startedAt ? { durationMs: Date.now() - startedAt } : {}),
  };
  // The actor, the store and anything a money path recorded with
  // `setLogContext` are already in the context bag and are stamped by the
  // logger itself — they are not repeated here.
  if (!outcome.mapped) {
    // The one line that replaces `console.error(error)`. Exactly one, at error,
    // with the stack — this is a fault the server owns.
    logger.error("request.failed", { ...fields, err: error });
    // ق-235: and the same fault, reported OUTSIDE. The log line above is only
    // read by someone who already knows to look; this one arrives. It is
    // attached HERE, to the unmapped branch, so the rule is inherited rather
    // than restated: what Sentry sees is exactly what the platform already
    // classifies as its own fault — never a refusal it made correctly. Inert
    // when SENTRY_DSN is unset, and it cannot throw.
    reportServerFault(error, { requestId: currentCorrelationId() ?? "unknown", route: fields.route, status: outcome.status });
    return;
  }
  if (outcome.status >= 500) {
    // Mapped, but still a 5xx: a missing default plan, image storage that is not
    // configured, a transition that could not be applied. Someone should see it
    // if it repeats; nobody should be paged for one.
    logger.warn("request.degraded", { ...fields, err: error });
    return;
  }
  // A 4xx is the CALLER'S mistake and the response already says so. Logging one
  // per unauthenticated poll would be the flood described in logger.ts.
  if (logger.isLevelEnabled("debug")) logger.debug("request.rejected", fields);
}

export function classifyError(error: unknown, request: Request): ErrorOutcome {
  // PG-2: `details` is absent on every pre-existing HttpError, so those bodies
  // stay byte-identical; only the restore-conflict errors carry extra keys.
  if (error instanceof HttpError) return { status: error.status, error: { code: error.code, message: error.message, ...(error.details ?? {}) }, mapped: true };
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  if (message.includes("CODIQ_EMAIL_CONFLICT")) {
    // 19-ب: the CODE stays (tests and clients name it); the MESSAGE no longer
    // claims the holder is specifically a platform owner or the claimant a
    // merchant — the trigger fires for any of the four identity tables.
    return { status: 409, error: { code: "EMAIL_RESERVED_FOR_PLATFORM_OWNER", message: "This email already belongs to another identity on the platform (owner, platform staff, merchant, or store staff) and cannot be reused." }, mapped: true };
  }
  // 19-د: the reserved-slug trigger is the LAST line, not the first — the three
  // application checks answer before it in every ordinary flow. It still needs a
  // sentence of its own: reaching a merchant as a bare 500 would tell him his
  // store failed to be created and not why, and «اختر رابطاً آخر» is the whole
  // actionable content. Matched on the trigger's own message text, exactly as
  // the category-cycle guard below is.
  if (message.includes("CODIQ_RESERVED_STORE_SLUG")) {
    return { status: 422, error: { code: "RESERVED_STORE_SLUG", message: "هذا الرابط محجوز للمنصة — اختر رابطاً آخر لمتجرك." }, mapped: true };
  }
  if (error instanceof multer.MulterError) {
    // Phase 20B-3: the CSV import shares the multer pipeline with its own 2 MB cap.
    if (request.path.includes("/catalog/import/")) {
      return { status: 422, error: { code: "CSV_FILE_TOO_LARGE", message: error.code === "LIMIT_FILE_SIZE" ? "ملف CSV يجب أن يكون 2 MB أو أصغر." : "رفع ملف CSV غير صالح — أرفق ملفاً واحداً في الحقل «file»." }, mapped: true };
    }
    // ق-238 — THE NUMBER IS READ, NOT TYPED.
    //
    // Three ceilings now, not one: a product image is re-encoded on the way in
    // so fifteen megabytes of source is fine, a banner or a logo is stored as
    // sent, and a prescription is a document nobody may resize. This sentence
    // used to carry «5 MB» as a literal for all three, so the moment one moved
    // it began telling a merchant a number the server does not enforce — which
    // is worse than saying nothing: it sends him to shrink a file that would
    // have been accepted.
    const prescription = request.path.includes("/prescription");
    const storeImage = request.path.includes("/banners") || request.path.endsWith("/storefront/logo");
    const code = prescription ? "INVALID_PRESCRIPTION_IMAGE" : "INVALID_PRODUCT_IMAGE";
    const noun = prescription ? "صورة الوصفة" : storeImage ? "صورة المتجر" : "صورة المنتج";
    const maxBytes = prescription
      ? prescriptionImageConstraints.maxBytes
      : storeImage
        ? storeImageConstraints.maxBytes
        : productImageConstraints.maxBytes;
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return { status: 422, error: { code, message: error.code === "LIMIT_FILE_SIZE" ? `${noun} يجب أن تكون ${maxMb} MB أو أصغر.` : `رفع ${noun} غير صالح.` }, mapped: true };
  }
  // MD-1: a concurrent tag replace on the SAME order. `replaceOrderTags` now
  // serializes on the order row, so this is the belt to that braces — but it
  // must never surface as «حساب بهذه الهوية موجود» (the generic identity
  // duplicate) or as a bare 500, which is exactly what both used to do.
  if (message.includes("at most 8 internal tags") || message.includes("order_tags_max_per_order")) {
    return { status: 409, error: { code: "ORDER_TAGS_CONFLICT", message: "جرى تعديل وسوم هذا الطلب في جلسة أخرى في اللحظة نفسها — أعِد فتح الطلب وحفظ الوسوم من جديد." }, mapped: true };
  }
  // 19-د: P2023 «Inconsistent column data» is Prisma refusing to coerce a value
  // into a typed column — in practice, a uuid column handed something that is
  // not a uuid. It matched NOTHING here: not an HttpError, not a MulterError,
  // not P2002, and neither `isCheckViolation` (23514) nor `isForeignKeyViolation`
  // (P2003/23503) recognises its code or its message. So it fell through to the
  // bare `console.error` + 500 INTERNAL_ERROR at the bottom of this function,
  // and `?cursor=abc` on any keyset list was an unhandled server error a signed-
  // in shopper could produce at will.
  //
  // The cursor validator in services/keyset-cursor.ts is the real fix and
  // answers first, with a message about the actual parameter. This is the floor
  // under it: a malformed id is the CALLER'S mistake, and a 400 says so. It must
  // stay a 4xx and never a 500 — a 500 is a page in the error budget and a
  // wake-up call about a fault the server does not have.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2023") {
    return { status: 400, error: { code: "INVALID_IDENTIFIER", message: "أحد المعرّفات في الطلب غير صالح." }, mapped: true };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
    // 19-ب: `codiq_guard_owner_merchant_staff_email` raises its own 23505 and
    // Prisma turns that into a P2002 with NO target and no message text —
    // `includes("CODIQ_EMAIL_CONFLICT")` above never sees it. A target-less
    // P2002 on an identity model IS that trigger, so it gets the same answer.
    if (!target || target === "null" || target === "undefined") {
      const model = (error.meta as { modelName?: unknown } | undefined)?.modelName;
      if (model === "PlatformOwner" || model === "Merchant" || model === "Staff" || model === "PlatformStaff") {
        return { status: 409, error: { code: "EMAIL_RESERVED_FOR_PLATFORM_OWNER", message: "This email already belongs to another identity on the platform (owner, platform staff, merchant, or store staff) and cannot be reused." }, mapped: true };
      }
    }
    if (target.includes("order_tags") || target.includes("tag_normalized")) {
      return { status: 409, error: { code: "ORDER_TAGS_CONFLICT", message: "جرى تعديل وسوم هذا الطلب في جلسة أخرى في اللحظة نفسها — أعِد فتح الطلب وحفظ الوسوم من جديد." }, mapped: true };
    }
    if (target.includes("product_categories")) return { status: 409, error: { code: "DUPLICATE_CATEGORY", message: "A category with this name already exists in this store." }, mapped: true };
    if (target.includes("coupons")) return { status: 409, error: { code: "DUPLICATE_COUPON_CODE", message: "A coupon with this code already exists in this store." }, mapped: true };
    if (target.includes("product_variants")) return { status: 409, error: { code: "DUPLICATE_VARIANT_SKU", message: "A variant with this SKU already exists in this store." }, mapped: true };
    if (target.includes("products")) return { status: 409, error: { code: "DUPLICATE_PRODUCT_SKU", message: "A product with this SKU already exists in this store." }, mapped: true };
    if (target.includes("stores") && (target.includes("slug") || target.includes("default_subdomain"))) return { status: 409, error: { code: "DUPLICATE_STORE_SLUG", message: "رابط المتجر مستخدم بالفعل." }, mapped: true };
    if (target.includes("phone_normalized")) {
      // The MODEL decides, not the column name — the two share it. Relying on
      // the index name here does not work: Prisma reports the column.
      const model = (error.meta as { modelName?: unknown } | undefined)?.modelName;
      if (model === "Merchant") return { status: 409, error: { code: "DUPLICATE_MERCHANT_PHONE", message: "رقم الهاتف مسجَّل لحساب تاجر آخر على المنصة." }, mapped: true };
      return { status: 409, error: { code: "DUPLICATE_CUSTOMER_PHONE", message: "This phone is already registered in this store." }, mapped: true };
    }
    if (target.includes("plan_upgrade_requests")) return { status: 409, error: { code: "DUPLICATE_UPGRADE_REQUEST", message: "لديك طلب ترقية معلق بالفعل — بانتظار مراجعة إدارة المنصة." }, mapped: true };
    return { status: 409, error: { code: "DUPLICATE_IDENTITY", message: "An account with this identity already exists in this permitted scope." }, mapped: true };
  }
  // PG-2: the category tree is guarded in TWO layers — the service walks it in
  // TypeScript, and `codiq_guard_category_cycle` re-checks it in SQL under a
  // per-store advisory lock, which is what makes the check race-free. The
  // trigger is therefore the authority, and any disagreement must reach the
  // merchant as the 422 that rule ALREADY speaks in Arabic — not as a 500 in
  // English logged as a server fault. The match is on the trigger's own message
  // text on purpose: every other 23514 in this schema (`deleted ⇒ inactive`,
  // `purge_block_requires_deleted`) is a broken invariant that MUST stay a 500.
  if (isCheckViolation(error) && message.includes("product_categories")) {
    if (message.includes("would exceed")) {
      return { status: 422, error: { code: "CATEGORY_DEPTH_EXCEEDED", message: "الحد الأقصى لعمق شجرة التصنيفات هو 3 مستويات." }, mapped: true };
    }
    if (message.includes("cycle") || message.includes("parent chain")) {
      return { status: 422, error: { code: "INVALID_CATEGORY_PARENT", message: "التصنيف الأب المحدد غير صالح — لا يمكن أن يكون التصنيف تحت أحد تصنيفاته الفرعية." }, mapped: true };
    }
  }
  // PG-2: a restricting foreign key is a MERCHANT-FACING conflict, not a server
  // fault. Before this branch, deleting a product that sat in a live customer
  // cart produced a bare 500 INTERNAL_ERROR — acceptance criterion 5 broken in
  // production. The mapping lives in services/soft-delete/fk-violations.ts, the
  // same table the purge job reads for `purge_block_reason`, so the HTTP answer
  // and the trash badge can never drift apart. The `23503` text branch catches
  // the raw-SQL path ($executeRaw), which never becomes a Prisma P2003.
  if (isForeignKeyViolation(error)) {
    const rule = fkRuleFor(foreignKeyConstraintName(error));
    if (rule) return { status: rule.status, error: { code: rule.code, message: rule.message, hint: "deactivate" }, mapped: true };
    return { status: 409, error: { code: "RESOURCE_REFERENCED", message: "لا يمكن تنفيذ العملية: هذا العنصر مرتبط بسجلات أخرى." }, mapped: true };
  }
  // 20-2 gate. `express.json({ limit: "1mb" })` refuses two things before any
  // route runs, and both were falling through to the 500 below — so a client
  // that sent one byte of bad JSON was told the SERVER had failed, and a client
  // that sent 2 MB was told the same. Neither is true, and neither is
  // actionable: a 500 says "retry, it is not your fault", which is the one
  // instruction that guarantees the caller keeps sending the same broken body.
  //
  // Read `error.type` rather than `instanceof SyntaxError`: body-parser stamps
  // the type, and a SyntaxError from anywhere else in a handler is a real bug
  // that must keep its 500 rather than be reported to the caller as his fault.
  const bodyParser = error as { type?: unknown; status?: unknown };
  if (bodyParser?.type === "entity.parse.failed") {
    return { status: 400, error: { code: "INVALID_JSON_BODY", message: "جسم الطلب ليس JSON صالحاً." }, mapped: true };
  }
  if (bodyParser?.type === "entity.too.large") {
    return { status: 413, error: { code: "REQUEST_BODY_TOO_LARGE", message: "حجم الطلب يتجاوز الحد المسموح (1 ميغابايت)." }, mapped: true };
  }
  // A lost race that outlived its retry budget is NOT a fault we own, and
  // answering 500 says it is.
  //
  // `isRetryableTransactionError` already names these four shapes, and every
  // retry loop on the platform spends its whole budget on them. When the budget
  // is finally exhausted the raw Prisma error reached this function and matched
  // NOTHING — P2034 appears nowhere else in this file — so a shopper who tapped
  // «تأكيد الطلب» during a busy minute was told «Unexpected server error». That
  // is the exact sentence ق-132 exists to prevent, and it is also a lie: nothing
  // is broken, the row was simply contended.
  //
  // 503 rather than 500 because the condition is TEMPORARY and retrying is the
  // correct response — which is what the message now tells him, in words he can
  // act on. It also stops paging an operator for contention: `logOutcome` files
  // a mapped 5xx as `request.degraded` (warn) instead of `request.failed`
  // (error with a stack).
  //
  // Deliberately the LAST branch. Every business refusal above answers first —
  // including the two body-parser shapes, which are about the REQUEST and can
  // never be a Prisma error — so this can only ever catch a genuine lost race.
  if (isRetryableTransactionError(error)) {
    return { status: 503, error: { code: "TRANSACTION_CONTENTION", message: "الخدمة مزدحمة هذه اللحظة ولم تكتمل العملية. أعد المحاولة بعد ثوانٍ — لم يُخصم شيء ولم يُسجَّل طلب." }, mapped: true };
  }
  return { status: 500, error: { code: "INTERNAL_ERROR", message: "Unexpected server error." }, mapped: false };
}

/**
 * A Postgres CHECK-constraint violation (23514). Prisma has no dedicated code
 * for it: the query engine wraps it in PrismaClientUnknownRequestError and a
 * `$executeRaw` surfaces the driver error directly, so all three shapes are read
 * here exactly as `isForeignKeyViolation` reads 23503.
 */
function isCheckViolation(error: unknown): boolean {
  const raw = error as { code?: unknown };
  if (raw?.code === "23514") return true;
  return error instanceof Error && error.message.includes("23514");
}
