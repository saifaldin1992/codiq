import { setStoreVerification, storeVerification } from "../../services/store-verification.service.js";
import { storeMessagingCaps, updateStoreMessagingCaps } from "../../services/messaging-caps.service.js";
import { messagingCapsSchema } from "../schemas/messaging-caps.schema.js";
import type { Express } from "express";
import multer from "multer";
import { HttpError } from "../../auth/auth.errors.js";
import { verifyTypedSession } from "../../auth/identity.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { assignMerchantSubscription, createPlan, createUpgradeRequest, decideUpgradeRequest, listMerchantsWithPlans, listPlans, listUpgradeRequests, merchantEntitlementsView, setPlanArchived, updatePlan } from "../../services/entitlement.service.js";
import { createManualReturnAdjustment, createSettlement, merchantFinanceReport, merchantSettlements, platformFinanceReport, previewSettlement } from "../../services/finance.service.js";
import { merchantWallet } from "../../services/merchant-wallet.service.js";
import { createManualMerchant } from "../../services/manual-provisioning.service.js";
import { setMerchantSuspension } from "../../services/merchant-suspension.service.js";
import { listPlatformStores } from "../../services/platform-directory.service.js";
import { decideMerchantApproval, listRegistrationRequests, selfRegistrationMode, setSelfRegistrationMode } from "../../services/registration.service.js";
import { clearPlatformLogo, platformLogoConstraints, putPlatformLogo, readPlatformLogo } from "../../services/platform-brand.service.js";
import { readPlatformContact, updatePlatformContact } from "../../services/platform-contact.service.js";
import { platformOverview } from "../../services/platform-overview.service.js";
import { platformPulse, pulseCohort } from "../../services/platform-pulse.service.js";
import { parseOrThrow } from "../validate.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import {
  assignMerchantSubscriptionSchema,
  createManualMerchantSchema,
  createPlanSchema,
  createReturnAdjustmentSchema,
  createSettlementSchema,
  settlementPreviewQuerySchema,
  createUpgradeRequestSchema,
  decideMerchantApprovalSchema,
  setMerchantSuspensionSchema,
  setRegistrationModeSchema,
  updatePlanSchema,
  updatePlatformContactSchema,
} from "../schemas/platform.schema.js";
import { asyncRoute, authenticatedUpload, bearerToken, limitUpload, uploadLimits, requirePlatformOwner, requireTrustedWriteOrigin , requireMerchantSession} from "../shared.js";

/** Memory storage: the logo is validated from its BYTES before it is stored. */
const platformLogoUpload = multer({ storage: multer.memoryStorage(), limits: uploadLimits({ fileSize: platformLogoConstraints.maxBytes, files: 1 }) });

/**
 * 19-د (ATTACK-SURFACE): brand.manage is proven before multer buffers a byte —
 * see `authenticatedUpload` in http/shared.ts.
 */
async function guardLogoUpload(request: import("express").Request) {
  requireTrustedWriteOrigin(request);
  const { actor } = await requirePlatformActor(request, "brand.manage");
  await limitUpload("platform_logo_upload", `${actor.kind}:${actor.id}`);
}

/**
 * 19-ب: the owner-only fields on the plans surface. `commissionBps` is the
 * platform's own take and `isActive` is the archive side-door
 * (entitlement.service.ts:219-223) — no permission code exists for either, so
 * a staff member sending one is refused whatever his overrides say.
 */
function refuseOwnerOnlyPlanFields(actorKind: "platform_owner" | "platform_staff", body: unknown, fields: readonly string[]) {
  if (actorKind !== "platform_staff") return;
  for (const field of fields) {
    if ((body as Record<string, unknown> | null | undefined)?.[field] !== undefined) {
      throw new HttpError(403, "OWNER_ONLY_FIELD", `الحقل ${field} من صلاحيات مالك المنصة وحده.`);
    }
  }
}

export function registerPlatformRoutes(app: Express) {
  // P27-13 (ق-101) — one aggregate call for the owner's home page. It replaces
  // three list-and-count-in-the-browser fetches, one of which («عدد التجار») was
  // silently wrong the moment the platform outgrew a single page of merchants.
  //
  // 19-ب guard swaps throughout this file: `requirePlatformActor` admits the
  // owner exactly as `requirePlatformOwner` did (same touch, same claims), and
  // additionally admits platform staff holding the named permission. Routes
  // that KEEP `requirePlatformOwner` (plan archive/unarchive, verification PUT)
  // are owner-only on purpose — no code exists that grants them.
  app.get("/platform/overview", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "overview.view");
    response.status(200).json({ overview: await platformOverview(request.query.days) });
  }));
  // PG-7 (ق-75) — business health. «نشط» means SOLD, and the endpoint ships its
  // own definitions so the interface can state them out loud (ق-10).
  app.get("/platform/pulse", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "overview.view");
    response.status(200).json({ pulse: await platformPulse(request.query.days) });
  }));
  // «مَن هم هؤلاء التجار تحديداً» — the acceptance criterion for PG-7: a number
  // the owner cannot open is a number he cannot act on.
  app.get("/platform/pulse/:cohort", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "overview.view");
    const cohort = request.params.cohort;
    if (cohort !== "active" && cohort !== "stalled" && cohort !== "never_sold") {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "الفئة المطلوبة غير موجودة.");
    }
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json(await pulseCohort(cohort, request.query.days, limit, cursor));
  }));
  // P27-20 (ق-107) — the platform's logo, now delegable behind brand.manage.
  app.get("/platform/brand/logo", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json({ logo: await readPlatformLogo(), constraints: platformLogoConstraints });
  }));
  app.put("/platform/brand/logo", authenticatedUpload(guardLogoUpload, platformLogoUpload.single("file")), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "brand.manage");
    if (!request.file) throw new HttpError(422, "INVALID_PLATFORM_LOGO", "أرفق ملف الشعار في الحقل «file».");
    response.status(200).json({ logo: await putPlatformLogo(actor, request.file, new Date()) });
  }));
  app.delete("/platform/brand/logo", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "brand.manage");
    await clearPlatformLogo(actor);
    // 200 with the new state, not 204: the client needs to know it is back on
    // the built-in mark without a second request.
    response.status(200).json({ logo: null });
  }));
  app.post("/platform/merchants/manual", asyncRoute(async (request, response) => {
    // The one platform write that was missing this. Fifteen siblings in this
    // file have it and this route — which creates a merchant account and sets
    // its password — did not. `SameSite=lax` on the session cookie already
    // stops a cross-site form POST, so this is the second lock rather than the
    // only one; a route that creates accounts should not be the single one
    // holding fewer locks than its neighbours.
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "merchants.manage");
    const body = parseOrThrow(createManualMerchantSchema, request.body ?? {});
    // Named field by field: `ownerName` and `phone` are `unknown` in the schema
    // on purpose, and an optional-typed spread would not satisfy the signature.
    response.status(201).json(await createManualMerchant(actor, {
      businessName: body.businessName,
      firstStoreName: body.firstStoreName,
      email: body.email,
      temporaryPassword: body.temporaryPassword,
      ownerName: body.ownerName,
      phone: body.phone,
    }));
  }));
  app.get("/platform/plans", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "plans.manage");
    response.status(200).json({ plans: await listPlans() });
  }));
  app.patch("/platform/plans/:planId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "plans.manage");
    // isActive via PATCH is the archive SIDE DOOR — refused for staff exactly
    // like the archive routes themselves. isRecommended joins them: moving
    // «توصية المنصة» onto a plan is the owner's commercial word, and it steers
    // every visitor reading the public pricing grid.
    // Read on the RAW body and BEFORE the schema, deliberately: a staff member
    // who sends `commissionBps` must be told it is the owner's field, not that
    // it was the wrong type. Answering the shape first would hide the boundary.
    refuseOwnerOnlyPlanFields(actor.kind, request.body, ["commissionBps", "isActive", "isRecommended"]);
    response.status(200).json({ plan: await updatePlan(request.params.planId, actor, parseOrThrow(updatePlanSchema, request.body ?? {})) });
  }));
  app.get("/platform/merchants", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "merchants.manage");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json(await listMerchantsWithPlans(limit, cursor));
  }));
  app.get("/platform/merchants/:merchantId/subscription", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "merchants.manage");
    response.status(200).json(await merchantEntitlementsView(request.params.merchantId));
  }));
  app.put("/platform/merchants/:merchantId/subscription", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "plans.manage");
    response.status(200).json(await assignMerchantSubscription(request.params.merchantId, parseOrThrow(assignMerchantSubscriptionSchema, request.body ?? {}), actor));
  }));
  // The three merchant-facing subscription/finance routes below were registered
  // between the platform blocks in the pre-split app.ts; they stay here so the
  // global registration order is byte-for-byte identical.
  app.get("/merchant/subscription", asyncRoute(async (request, response) => {
    const claims = await requireMerchantSession(request);
    response.status(200).json(await merchantEntitlementsView(claims.subjectId));
  }));
  app.get("/merchant/finance/report", asyncRoute(async (request, response) => {
    const claims = await requireMerchantSession(request);
    response.status(200).json(await merchantFinanceReport(claims.subjectId, request.query));
  }));
  // MD-5 «محفظتي» — a READ over the append-only ledger, never a stored balance.
  // A stored one could disagree with the ledger, and the ledger is the record
  // that cannot be edited.
  // MD-6: the badge is the OWNER's to grant and to revoke. The evidence beside
  // it is computed live, so a refusal can be explained to a merchant in figures
  // rather than in taste. Reading it rides merchants.manage; GRANTING stays
  // owner-only (19-ب: no permission code exists for the platform's word).
  app.get("/platform/stores/:storeSlug/verification", asyncRoute(async (request, response) => { await requirePlatformActor(request, "merchants.manage"); response.status(200).json({ verification: await storeVerification(request.params.storeSlug) }); }));
  app.put("/platform/stores/:storeSlug/verification", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); const owner = await requirePlatformOwner(request); response.status(200).json({ verification: await setStoreVerification(request.params.storeSlug, owner.subjectId, request.body ?? {}) }); }));
  // ق-180: the three daily ceilings (PG-3, 19-د) were columns «so the platform
  // owner can tighten a particular store without a deploy» — and had no writer
  // but a test. Reading rides merchants.manage; WRITING stays owner-only, like
  // the verification badge above: these are anti-abuse walls, not settings.
  app.get("/platform/stores/:storeSlug/messaging-caps", asyncRoute(async (request, response) => { await requirePlatformActor(request, "merchants.manage"); response.status(200).json(await storeMessagingCaps(request.params.storeSlug)); }));
  app.put("/platform/stores/:storeSlug/messaging-caps", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); const owner = await requirePlatformOwner(request); response.status(200).json(await updateStoreMessagingCaps(request.params.storeSlug, parseOrThrow(messagingCapsSchema, request.body ?? {}), { kind: "platform_owner", id: owner.subjectId })); }));

  app.get("/merchant/finance/wallet", asyncRoute(async (request, response) => {
    const claims = await requireMerchantSession(request);
    response.status(200).json({ wallet: await merchantWallet(claims.subjectId) });
  }));
  app.get("/merchant/finance/settlements", asyncRoute(async (request, response) => {
    const claims = await requireMerchantSession(request);
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json(await merchantSettlements(claims.subjectId, limit, cursor));
  }));
  app.get("/platform/finance/report", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "finance.view");
    response.status(200).json(await platformFinanceReport(request.query));
  }));
  app.post("/platform/finance/settlements", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "finance.settle");
    response.status(201).json({ settlement: await createSettlement(actor, parseOrThrow(createSettlementSchema, request.body ?? {})) });
  }));
  // Audit 17-ب: the amount is shown BEFORE the operator confirms, from the same
  // computation the write uses. `finance.settle`, not `.view`: this is the
  // settle form's own read, and it states the money about to be transferred.
  app.get("/platform/finance/settlements/:merchantId/preview", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "finance.settle");
    const query = parseOrThrow(settlementPreviewQuerySchema, request.query);
    response.status(200).json({ preview: await previewSettlement({ merchantId: request.params.merchantId, ...query }) });
  }));
  app.get("/platform/finance/settlements/:merchantId", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "finance.view");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json(await merchantSettlements(request.params.merchantId, limit, cursor));
  }));
  app.post("/platform/finance/adjustments", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "finance.settle");
    const body = parseOrThrow(createReturnAdjustmentSchema, request.body ?? {});
    response.status(201).json({ entry: await createManualReturnAdjustment(actor, { orderId: body.orderId, note: body.note }) });
  }));
  app.get("/platform/settings/registration", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "registrations.approve");
    response.status(200).json({ mode: await selfRegistrationMode() });
  }));
  app.put("/platform/settings/registration", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "registrations.approve");
    response.status(200).json(await setSelfRegistrationMode(actor, parseOrThrow(setRegistrationModeSchema, request.body ?? {})));
  }));
  /**
   * PC-1 — «معلومات التواصل». OWNER-ONLY, both directions.
   *
   * No permission code grants these: the platform's public email and phone are
   * the channel every visitor and every merchant is told to use, and moving them
   * is the owner's word in the same way the plan commission and «توصية المنصة»
   * are. The world reads the same three fields without a session at
   * `GET /public/contact` — the read here is owner-only because it carries one
   * extra field (`whatsappIsSeparate`) that only his own form needs.
   */
  app.get("/platform/settings/contact", asyncRoute(async (request, response) => {
    await requirePlatformOwner(request);
    response.status(200).json({ contact: await readPlatformContact() });
  }));
  app.put("/platform/settings/contact", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    const body = parseOrThrow(updatePlatformContactSchema, request.body ?? {});
    const contact = await updatePlatformContact({ kind: "platform_owner", id: claims.subjectId }, { email: body.email, phone: body.phone, whatsapp: body.whatsapp ?? null });
    response.status(200).json({ contact });
  }));
  app.get("/platform/merchants/registration-requests", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "registrations.approve");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json(await listRegistrationRequests(limit, cursor));
  }));
  app.post("/platform/merchants/:merchantId/approval", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "registrations.approve");
    response.status(200).json(await decideMerchantApproval(request.params.merchantId, actor, parseOrThrow(decideMerchantApprovalSchema, request.body ?? {})));
  }));
  // ق-225 — the lever the platform did not have: stopping a merchant it has
  // already approved. `merchants.manage` rather than owner-only, because a role
  // that may REJECT a registration already writes these same two columns on
  // these same rows; see the service header for the whole argument.
  app.post("/platform/merchants/:merchantId/suspension", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "merchants.manage");
    const body = parseOrThrow(setMerchantSuspensionSchema, request.body ?? {});
    response.status(200).json({ suspension: await setMerchantSuspension(request.params.merchantId, actor, body) });
  }));
  // Menus pass A: read-only platform-wide store directory for the dashboard.
  app.get("/platform/stores", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "merchants.manage");
    response.status(200).json(await listPlatformStores(request.query));
  }));
  // Approved addition (2026-08-26): full plan management — create + archive
  // instead of delete — and the merchant upgrade-request queue.
  // CREATION is OWNER-ONLY, like archiving — and for the same reason, learned
  // the hard way in review: refusing only the `commissionBps` FIELD protected
  // the field name, not the platform's revenue. `createPlan` defaults an
  // omitted commission to 0 and a new plan is born active, so a staff member
  // with plans.manage could mint a 0% plan, move merchants onto it (the same
  // code guards assignment), and every completed order after that books zero
  // commission into an append-only ledger. The economic act is the owner's;
  // no permission code grants it. Staff still EDIT existing plans, where the
  // owner-only fields are refused one by one below.
  app.post("/platform/plans", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    response.status(201).json({ plan: await createPlan({ kind: "platform_owner", id: claims.subjectId }, parseOrThrow(createPlanSchema, request.body ?? {})) });
  }));
  // Archiving stays OWNER-ONLY (19-ب): pulling a plan from the market is the
  // owner's word, and no permission code exists that grants it.
  app.post("/platform/plans/:planId/archive", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    response.status(200).json({ plan: await setPlanArchived(request.params.planId, { kind: "platform_owner", id: claims.subjectId }, true) });
  }));
  app.post("/platform/plans/:planId/unarchive", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    response.status(200).json({ plan: await setPlanArchived(request.params.planId, { kind: "platform_owner", id: claims.subjectId }, false) });
  }));
  app.post("/merchant/subscription/upgrade-request", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requireMerchantSession(request);
    response.status(201).json({ request: await createUpgradeRequest(claims.subjectId, parseOrThrow(createUpgradeRequestSchema, request.body ?? {})) });
  }));
  app.get("/platform/upgrade-requests", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "plans.manage");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json(await listUpgradeRequests(limit, cursor, request.query.status));
  }));
  app.post("/platform/upgrade-requests/:requestId/approve", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "plans.manage");
    response.status(200).json({ request: await decideUpgradeRequest(request.params.requestId, actor, "approve") });
  }));
  app.post("/platform/upgrade-requests/:requestId/reject", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "plans.manage");
    response.status(200).json({ request: await decideUpgradeRequest(request.params.requestId, actor, "reject") });
  }));
}
