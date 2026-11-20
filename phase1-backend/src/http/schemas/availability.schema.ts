/**
 * المرحلة 29 (ق-249) — the shapes of the platform's control layer. Shape here,
 * meaning in the services (the house rule): the named refusals — INVALID_
 * SERVICE_STATE, INVALID_OVERRIDE_REASON, INVALID_STORE_STATUS … — live beside
 * the rule that gives them meaning, so this file only says which keys exist.
 */
import { z } from "zod";

export const updateServiceSchema = z.object({
  state: z.unknown().optional(),
  name: z.unknown().optional(),
  description: z.unknown().optional(),
});

export const updateCapabilitySchema = z.object({
  state: z.unknown().optional(),
});

export const createOverrideSchema = z.object({
  scope: z.unknown().optional(),
  /** A store slug or a merchant email — resolved to ids on the server; never an id typed by hand. */
  storeSlug: z.unknown().optional(),
  merchantEmail: z.unknown().optional(),
  serviceCode: z.unknown().optional(),
  capabilityCode: z.unknown().optional(),
  state: z.unknown().optional(),
  reason: z.unknown().optional(),
  startsAt: z.unknown().optional(),
  endsAt: z.unknown().optional(),
});

export const upsertFeatureFlagSchema = z.object({
  description: z.unknown().optional(),
  enabledDefault: z.unknown().optional(),
});

export const addFeatureFlagRuleSchema = z.object({
  scope: z.unknown().optional(),
  enabled: z.unknown().optional(),
  planCode: z.unknown().optional(),
  merchantEmail: z.unknown().optional(),
  storeSlug: z.unknown().optional(),
  percentage: z.unknown().optional(),
});

export const setStoreStatusSchema = z.object({
  status: z.unknown().optional(),
  message: z.unknown().optional(),
  maintenanceUntil: z.unknown().optional(),
});

export const platformStoreStatusSchema = z.object({
  status: z.unknown().optional(),
  message: z.unknown().optional(),
});

// ق-250 — maintenance windows and incidents
export const scheduleMaintenanceWindowSchema = z.object({
  scope: z.unknown().optional(),
  serviceCode: z.unknown().optional(),
  capabilityCode: z.unknown().optional(),
  merchantEmail: z.unknown().optional(),
  storeSlug: z.unknown().optional(),
  startsAt: z.unknown().optional(),
  endsAt: z.unknown().optional(),
  messageAr: z.unknown().optional(),
  messageEn: z.unknown().optional(),
  affects: z.unknown().optional(),
});

export const scheduleStoreMaintenanceWindowSchema = z.object({
  startsAt: z.unknown().optional(),
  endsAt: z.unknown().optional(),
  messageAr: z.unknown().optional(),
  messageEn: z.unknown().optional(),
});

export const openIncidentSchema = z.object({
  title: z.unknown().optional(),
  severity: z.unknown().optional(),
  publicMessage: z.unknown().optional(),
  affects: z.unknown().optional(),
  blocks: z.unknown().optional(),
});

export const incidentUpdateSchema = z.object({
  status: z.unknown().optional(),
  message: z.unknown().optional(),
  publicMessage: z.unknown().optional(),
  blocks: z.unknown().optional(),
});

// ق-251 — one value for one registry code; null clears the level's opinion
export const setSettingSchema = z.object({
  value: z.unknown().optional(),
});
