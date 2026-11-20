/**
 * المرحلة 29 (ق-249) — the shapes of the platform's control layer. Shape here,
 * meaning in the services (the house rule): the named refusals — INVALID_
 * SERVICE_STATE, INVALID_OVERRIDE_REASON, INVALID_STORE_STATUS … — live beside
 * the rule that gives them meaning, so this file only says which keys exist.
 */
import { z } from "zod";

export const updateServiceSchema = z.object({
  state: z.unknown(),
  name: z.unknown(),
  description: z.unknown(),
});

export const updateCapabilitySchema = z.object({
  state: z.unknown(),
});

export const createOverrideSchema = z.object({
  scope: z.unknown(),
  /** A store slug or a merchant email — resolved to ids on the server; never an id typed by hand. */
  storeSlug: z.unknown(),
  merchantEmail: z.unknown(),
  serviceCode: z.unknown(),
  capabilityCode: z.unknown(),
  state: z.unknown(),
  reason: z.unknown(),
  startsAt: z.unknown(),
  endsAt: z.unknown(),
});

export const upsertFeatureFlagSchema = z.object({
  description: z.unknown(),
  enabledDefault: z.unknown(),
});

export const addFeatureFlagRuleSchema = z.object({
  scope: z.unknown(),
  enabled: z.unknown(),
  planCode: z.unknown(),
  merchantEmail: z.unknown(),
  storeSlug: z.unknown(),
  percentage: z.unknown(),
});

export const setStoreStatusSchema = z.object({
  status: z.unknown(),
  message: z.unknown(),
  maintenanceUntil: z.unknown(),
});

export const platformStoreStatusSchema = z.object({
  status: z.unknown(),
  message: z.unknown(),
});

// ق-250 — maintenance windows and incidents
export const scheduleMaintenanceWindowSchema = z.object({
  scope: z.unknown(),
  serviceCode: z.unknown(),
  capabilityCode: z.unknown(),
  merchantEmail: z.unknown(),
  storeSlug: z.unknown(),
  startsAt: z.unknown(),
  endsAt: z.unknown(),
  messageAr: z.unknown(),
  messageEn: z.unknown(),
  affects: z.unknown(),
});

export const scheduleStoreMaintenanceWindowSchema = z.object({
  startsAt: z.unknown(),
  endsAt: z.unknown(),
  messageAr: z.unknown(),
  messageEn: z.unknown(),
});

export const openIncidentSchema = z.object({
  title: z.unknown(),
  severity: z.unknown(),
  publicMessage: z.unknown(),
  affects: z.unknown(),
  blocks: z.unknown(),
});

export const incidentUpdateSchema = z.object({
  status: z.unknown(),
  message: z.unknown(),
  publicMessage: z.unknown(),
  blocks: z.unknown(),
});

// ق-251 — one value for one registry code; null clears the level's opinion
export const setSettingSchema = z.object({
  value: z.unknown(),
});
