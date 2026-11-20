/**
 * المرحلة 29 (ق-249) — the owner's control room: the service catalogue, the
 * overrides, the feature flags, and the one store switch only the platform
 * holds (suspend / lift).
 *
 * Two permissions, because they are two jobs: `services.manage` (what the
 * platform offers and how it is rolled out) and `availability.manage` (what is
 * switched off, where, and why — the operational hand). Both sit with the
 * supervisor; the registrations admin and the accountant hold neither.
 */
import type { Express } from "express";
import { HttpError } from "../../auth/auth.errors.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { prisma } from "../../db/prisma.js";
import {
  listAvailabilityOverrides, listServiceCatalogue, revokeAvailabilityOverride, setAvailabilityOverride,
  setStoreStatusByPlatform, updateCapabilityState, updateServiceState,
} from "../../services/availability.service.js";
import { addFeatureFlagRule, listFeatureFlags, removeFeatureFlagRule, upsertFeatureFlag } from "../../services/feature-flags.service.js";
import { addIncidentUpdate, listIncidents, openIncident } from "../../services/incidents.service.js";
import { cancelMaintenanceWindow, listMaintenanceWindows, scheduleMaintenanceWindow } from "../../services/maintenance.service.js";
import { platformConfigView, setPlatformSetting } from "../../services/config.service.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { addFeatureFlagRuleSchema, createOverrideSchema, incidentUpdateSchema, openIncidentSchema, platformStoreStatusSchema, scheduleMaintenanceWindowSchema, setSettingSchema, updateCapabilitySchema, updateServiceSchema, upsertFeatureFlagSchema } from "../schemas/availability.schema.js";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";
import { parseOrThrow } from "../validate.js";

/** Targets are named by what a person can read off a screen — a slug, an email — never by a uuid typed by hand. */
async function resolveMerchantByEmail(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "OVERRIDE_TARGET_REQUIRED", "بريد التاجر نصّ.");
  const merchant = await prisma.merchant.findUnique({ where: { email: value.trim().toLowerCase() }, select: { id: true } });
  if (!merchant) throw new HttpError(404, "MERCHANT_NOT_FOUND", "لا تاجر بهذا البريد.");
  return merchant.id;
}
async function resolveStoreBySlug(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "OVERRIDE_TARGET_REQUIRED", "رابط المتجر نصّ.");
  const store = await prisma.store.findUnique({ where: { slug: value.trim().toLowerCase() }, select: { id: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "لا متجر بهذا الرابط.");
  return store.id;
}
async function resolvePlanByCode(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_FLAG_RULE", "رمز الخطّة نصّ.");
  const plan = await prisma.plan.findUnique({ where: { code: value.trim() }, select: { id: true } });
  if (!plan) throw new HttpError(404, "PLAN_NOT_FOUND", "لا خطّة بهذا الرمز.");
  return plan.id;
}

export function registerPlatformServicesRoutes(app: Express) {
  // ---------- the catalogue: read by both jobs, written by services.manage
  app.get("/platform/services", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "services.manage");
    response.status(200).json({ services: await listServiceCatalogue() });
  }));
  app.patch("/platform/services/:code", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "services.manage");
    const body = parseOrThrow(updateServiceSchema, request.body ?? {});
    response.status(200).json({ service: await updateServiceState(actor, request.params.code, body) });
  }));
  app.patch("/platform/capabilities/:code", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "services.manage");
    const body = parseOrThrow(updateCapabilitySchema, request.body ?? {});
    response.status(200).json({ capability: await updateCapabilityState(actor, request.params.code, body) });
  }));

  // ---------- overrides: the operational hand
  app.get("/platform/availability/overrides", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "availability.manage");
    const query = parseOrThrow(paginationQuerySchema, request.query ?? {});
    response.status(200).json(await listAvailabilityOverrides(query.limit, query.cursor, request.query.live));
  }));
  app.post("/platform/availability/overrides", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    const body = parseOrThrow(createOverrideSchema, request.body ?? {});
    const [merchantId, storeId] = await Promise.all([resolveMerchantByEmail(body.merchantEmail), resolveStoreBySlug(body.storeSlug)]);
    response.status(201).json({ override: await setAvailabilityOverride(actor, { ...body, merchantId, storeId }) });
  }));
  app.delete("/platform/availability/overrides/:overrideId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    response.status(200).json({ override: await revokeAvailabilityOverride(actor, request.params.overrideId) });
  }));

  // ---------- the platform's store switch
  app.patch("/platform/stores/:storeSlug/status", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    const store = await prisma.store.findUnique({ where: { slug: request.params.storeSlug }, select: { id: true, slug: true } });
    if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "لا متجر بهذا الرابط.");
    const body = parseOrThrow(platformStoreStatusSchema, request.body ?? {});
    response.status(200).json({ storeSlug: store.slug, ...(await setStoreStatusByPlatform(actor, store.id, body)) });
  }));

  // ---------- ق-250: maintenance windows — the clock runs them; the owner schedules and cancels
  app.get("/platform/maintenance-windows", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "availability.manage");
    const query = parseOrThrow(paginationQuerySchema, request.query ?? {});
    response.status(200).json(await listMaintenanceWindows(query.limit, query.cursor, { live: request.query.live !== "false" }));
  }));
  app.post("/platform/maintenance-windows", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    const body = parseOrThrow(scheduleMaintenanceWindowSchema, request.body ?? {});
    const window = await scheduleMaintenanceWindow(actor, { ...body, merchantId: await resolveMerchantByEmail(body.merchantEmail), storeId: await resolveStoreBySlug(body.storeSlug) });
    response.status(201).json({ window });
  }));
  app.delete("/platform/maintenance-windows/:id", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    response.status(200).json({ window: await cancelMaintenanceWindow(actor, request.params.id) });
  }));

  // ---------- ق-250: incidents — said out loud, moved forward, never edited
  app.get("/platform/incidents", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "availability.manage");
    const query = parseOrThrow(paginationQuerySchema, request.query ?? {});
    response.status(200).json(await listIncidents(query.limit, query.cursor, { open: request.query.open !== "false" }));
  }));
  app.post("/platform/incidents", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    const body = parseOrThrow(openIncidentSchema, request.body ?? {});
    response.status(201).json({ incident: await openIncident(actor, body) });
  }));
  app.post("/platform/incidents/:id/updates", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "availability.manage");
    const body = parseOrThrow(incidentUpdateSchema, request.body ?? {});
    response.status(200).json({ incident: await addIncidentUpdate(actor, request.params.id, body) });
  }));

  // ---------- ق-251: the configuration hierarchy — a closed registry; this is the platform's level
  app.get("/platform/config", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "services.manage");
    response.status(200).json({ settings: await platformConfigView() });
  }));
  app.put("/platform/config/:code", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "services.manage");
    const body = parseOrThrow(setSettingSchema, request.body ?? {});
    response.status(200).json({ setting: await setPlatformSetting(actor, request.params.code, body.value) });
  }));

  // ---------- feature flags: rollout, never authorization
  app.get("/platform/feature-flags", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "services.manage");
    response.status(200).json({ flags: await listFeatureFlags() });
  }));
  app.put("/platform/feature-flags/:code", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "services.manage");
    const body = parseOrThrow(upsertFeatureFlagSchema, request.body ?? {});
    response.status(200).json({ flag: await upsertFeatureFlag(actor, request.params.code, body) });
  }));
  app.post("/platform/feature-flags/:code/rules", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "services.manage");
    const body = parseOrThrow(addFeatureFlagRuleSchema, request.body ?? {});
    const [planId, merchantId, storeId] = await Promise.all([resolvePlanByCode(body.planCode), resolveMerchantByEmail(body.merchantEmail), resolveStoreBySlug(body.storeSlug)]);
    response.status(201).json({ flag: await addFeatureFlagRule(actor, request.params.code, { scope: body.scope, enabled: body.enabled, percentage: body.percentage, planId, merchantId, storeId }) });
  }));
  app.delete("/platform/feature-flags/:code/rules/:ruleId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { actor } = await requirePlatformActor(request, "services.manage");
    response.status(200).json({ flag: await removeFeatureFlagRule(actor, request.params.code, request.params.ruleId) });
  }));
}
