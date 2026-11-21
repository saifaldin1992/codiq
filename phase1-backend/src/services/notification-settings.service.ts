/**
 * codiq phase 15 — merchant-facing notification settings and delivery log.
 * The store context always comes from the server-resolved session; provider
 * credentials live in server environment only and are never returned here.
 */
import { capsFromRow } from "./messaging-caps.service.js";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { isEmailProviderConfigured } from "../notifications/notification-provider.js";
import {
  normalizeCourierDispatchSettings,
  normalizePreferences,
  type NotificationPreferences,
} from "../notifications/notification-outbox.service.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "./list-page.js";
import {
  normalizeWhatsappTemplates,
  validateWhatsappTemplatesInput,
} from "./whatsapp-manual.service.js";
import { openSecret, sealSecret } from "../auth/secret-box.js";

/**
 * 19-د (D-40) — `notification_settings.api_key`.
 *
 * The column is a merchant's provider credential and was stored in the clear
 * alongside the two TOTP secrets. It has no writer in the platform TODAY — the
 * Iraqi SMS provider is still uncontracted, and `store-bootstrap.service.ts`
 * creates every row with `apiKey: null` — but a column that is one integration
 * away from holding live credentials is exactly the one to seal BEFORE it does.
 *
 * These two functions are the only sanctioned door. When the SMS integration
 * lands it calls them and gets encryption at rest for free; a `prisma.update`
 * that writes the column directly is the mistake this pair exists to make
 * obvious in review.
 */
const API_KEY_PURPOSE = "notification-api-key" as const;

/** The one place the provider key comes back in the clear. */
export async function notificationApiKey(storeId: string): Promise<string | null> {
  const settings = await prisma.notificationSettings.findUnique({
    where: { storeId },
    select: { apiKey: true },
  });
  if (!settings?.apiKey) return null;
  return openSecret(API_KEY_PURPOSE, settings.apiKey);
}

/** The one place it is written. `null` clears it. */
export async function setNotificationApiKey(storeId: string, apiKey: string | null): Promise<void> {
  await prisma.notificationSettings.update({
    where: { storeId },
    data: { apiKey: apiKey === null || apiKey === "" ? null : sealSecret(API_KEY_PURPOSE, apiKey) },
  });
}

export async function notificationSettingsView(storeId: string) {
  const settings = await prisma.notificationSettings.findUnique({
    where: { storeId },
    select: {
      isEnabled: true,
      configuration: true,
      senderId: true,
      dailyDigestEnabled: true,
      dailyDigestHour: true,
      marketingDailyCap: true,
      operationalDailyCap: true,
      operationalRecipientDailyCap: true,
    },
  });
  return {
    isEnabled: settings?.isEnabled === true,
    preferences: normalizePreferences(settings?.configuration),
    // CD-1b: a SIBLING of `preferences`, never a fourth key inside it — phase 15
    // asserts that object with a strict deepEqual.
    courierDispatch: normalizeCourierDispatchSettings(settings?.configuration),
    // MD-3: real COLUMNS, not a block inside `configuration`, because the
    // digest scanner filters on them in SQL — `WHERE daily_digest_enabled`
    // is an index-able predicate and a JSON path over every store is not.
    // A sibling of `preferences` for the same reason courierDispatch is one.
    dailyDigest: {
      enabled: settings?.dailyDigestEnabled === true,
      hour: settings?.dailyDigestHour ?? 20,
    },
    senderId: settings?.senderId ?? null,
    emailProviderConfigured: isEmailProviderConfigured(),
    smsProviderConfigured: false,
    // ق-180: the three ceilings the worker enforces (PG-3, 19-د). READ here;
    // written only by the platform owner — the update schema below does not
    // admit them, on purpose: two of the three are anti-abuse walls.
    caps: capsFromRow(settings),
    // WA-1 (ق-131/ق-139): a SIBLING block like courierDispatch — never a fourth
    // key inside `preferences` (phase 15 and CD-1 pin that trio by deepEqual).
    whatsappTemplates: normalizeWhatsappTemplates(settings?.configuration),
    // The honesty flag beside the provider flags: WhatsApp today is prefilled
    // wa.me links the merchant taps — manual, never claimed as automation.
    whatsappMode: "manual" as const,
  };
}

/**
 * 19-ج: the HTTP edge now parses this body through
 * `notificationSettingsUpdateSchema`, so a shape failure answers 422
 * VALIDATION_FAILED naming the field. The guards below STAY — this function is
 * exported and callable from anywhere, and a public function that trusts its
 * caller is one waiting to be called wrongly (the rule product-review.service.ts
 * states for the same reason).
 */
export async function updateNotificationPreferences(
  storeId: string,
  body: Record<string, unknown>
) {
  if (body.isEnabled !== undefined && typeof body.isEnabled !== "boolean") {
    throw new HttpError(422, "INVALID_INPUT", "isEnabled must be boolean.");
  }
  const rawPreferences = body.preferences === undefined ? {} : body.preferences;
  if (
    typeof rawPreferences !== "object" ||
    rawPreferences === null ||
    Array.isArray(rawPreferences)
  ) {
    throw new HttpError(422, "INVALID_INPUT", "preferences must be an object.");
  }
  const allowedKeys: (keyof NotificationPreferences)[] = [
    "orderCreated",
    "orderStatusChanged",
    "lowStock",
  ];
  const requested = rawPreferences as Record<string, unknown>;
  for (const key of Object.keys(requested)) {
    if (!allowedKeys.includes(key as keyof NotificationPreferences))
      throw new HttpError(422, "INVALID_INPUT", `Unknown preference: ${key}`);
    if (typeof requested[key] !== "boolean")
      throw new HttpError(422, "INVALID_INPUT", `${key} must be boolean.`);
  }

  // CD-1b: the courier toggle is a TOP-LEVEL body key, deliberately not a member
  // of `preferences` (see normalizeCourierDispatchSettings for why).
  if (body.courierDispatch !== undefined) {
    const requestedCourier = body.courierDispatch;
    if (
      typeof requestedCourier !== "object" ||
      requestedCourier === null ||
      Array.isArray(requestedCourier)
    ) {
      throw new HttpError(422, "INVALID_INPUT", "courierDispatch must be an object.");
    }
    for (const key of Object.keys(requestedCourier as Record<string, unknown>)) {
      if (key !== "enabled")
        throw new HttpError(422, "INVALID_INPUT", `Unknown courierDispatch key: ${key}`);
      if (typeof (requestedCourier as Record<string, unknown>).enabled !== "boolean")
        throw new HttpError(422, "INVALID_INPUT", "enabled must be boolean.");
    }
  }

  // MD-3: the digest toggle and its hour. Validated here rather than trusted to
  // the CHECK constraint so the merchant gets a message he can read instead of
  // a 500 from Postgres.
  let dailyDigest: { enabled?: boolean; hour?: number } | undefined;
  if (body.dailyDigest !== undefined) {
    const requestedDigest = body.dailyDigest;
    if (
      typeof requestedDigest !== "object" ||
      requestedDigest === null ||
      Array.isArray(requestedDigest)
    ) {
      throw new HttpError(422, "INVALID_INPUT", "dailyDigest must be an object.");
    }
    const entries = requestedDigest as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
      if (key !== "enabled" && key !== "hour")
        throw new HttpError(422, "INVALID_INPUT", `Unknown dailyDigest key: ${key}`);
    }
    if (entries.enabled !== undefined && typeof entries.enabled !== "boolean")
      throw new HttpError(422, "INVALID_INPUT", "enabled must be boolean.");
    if (
      entries.hour !== undefined &&
      (!Number.isInteger(entries.hour) ||
        (entries.hour as number) < 0 ||
        (entries.hour as number) > 23)
    ) {
      throw new HttpError(422, "INVALID_INPUT", "hour must be an integer between 0 and 23.");
    }
    dailyDigest = entries as { enabled?: boolean; hour?: number };
  }

  // WA-1 (ق-139): the templates block is a TOP-LEVEL body key like
  // courierDispatch. Validation (allow-listed keys, string, length cap, and the
  // {{token}} allow-list) lives beside the templates themselves.
  const whatsappTemplatesInput =
    body.whatsappTemplates !== undefined
      ? validateWhatsappTemplatesInput(body.whatsappTemplates)
      : undefined;

  const current = await prisma.notificationSettings.findUnique({
    where: { storeId },
    select: { configuration: true },
  });
  if (!current)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "Notification settings were not found for this store."
    );
  const mergedPreferences = {
    ...normalizePreferences(current.configuration),
    ...(requested as Partial<NotificationPreferences>),
  };
  // Phase 20B-2: configuration now also carries the abandonedCart block —
  // spread the current object first so a preferences write never clobbers it.
  // CD-1b adds courierDispatch under the same rule; WA-1 adds whatsappTemplates.
  const currentConfiguration = (current.configuration ?? {}) as Record<string, unknown>;
  const mergedCourierDispatch = {
    ...normalizeCourierDispatchSettings(currentConfiguration),
    ...(body.courierDispatch !== undefined ? (body.courierDispatch as { enabled: boolean }) : {}),
  };
  // Overrides only: a key holding the code default is NOT stored, and an empty
  // string in the input deleted its override in validateWhatsappTemplatesInput —
  // so «revert to default» is a real deletion, not a frozen copy of today's text.
  const storedWhatsappBlock =
    currentConfiguration.whatsappTemplates &&
    typeof currentConfiguration.whatsappTemplates === "object" &&
    !Array.isArray(currentConfiguration.whatsappTemplates)
      ? (currentConfiguration.whatsappTemplates as Record<string, unknown>)
      : {};
  const currentWhatsappBlock: Record<string, string> = {};
  for (const [key, value] of Object.entries(storedWhatsappBlock)) {
    if (typeof value === "string") currentWhatsappBlock[key] = value;
  }
  let mergedWhatsappTemplates = currentWhatsappBlock;
  if (whatsappTemplatesInput !== undefined) {
    mergedWhatsappTemplates = { ...currentWhatsappBlock };
    // Every key the client NAMED is either a new override (validated value) or
    // an explicit revert (empty string → dropped by the validator → deleted).
    for (const key of Object.keys(body.whatsappTemplates as Record<string, unknown>)) {
      if (whatsappTemplatesInput[key] !== undefined)
        mergedWhatsappTemplates[key] = whatsappTemplatesInput[key];
      else delete mergedWhatsappTemplates[key];
    }
  }
  await prisma.notificationSettings.update({
    where: { storeId },
    data: {
      ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
      ...(dailyDigest?.enabled !== undefined ? { dailyDigestEnabled: dailyDigest.enabled } : {}),
      ...(dailyDigest?.hour !== undefined ? { dailyDigestHour: dailyDigest.hour } : {}),
      configuration: {
        ...currentConfiguration,
        preferences: mergedPreferences,
        courierDispatch: mergedCourierDispatch,
        whatsappTemplates: mergedWhatsappTemplates,
      },
    },
  });
  return notificationSettingsView(storeId);
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const NOTIFICATION_LOG_KIND = "merchant.notifications.log";

export async function listNotificationLog(storeId: string, rawLimit: unknown, rawCursor: unknown) {
  const limit = parseListLimit(rawLimit);
  // 20-2: opaque `(createdAt, id)` keyset; `legacy:` is the one-time ramp for
  // the bare outbox uuid this route minted before this branch, still resolved
  // store-scoped so a foreign id stays a 404.
  const cursor = await readListCursor(NOTIFICATION_LOG_KIND, rawCursor, {
    legacy: async (id) => {
      const row = await prisma.notificationOutbox.findFirst({
        where: { id, storeId },
        select: { createdAt: true },
      });
      return row ? { value: row.createdAt } : null;
    },
  });
  const rows = await prisma.notificationOutbox.findMany({
    where: { storeId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      eventType: true,
      recipientKind: true,
      channel: true,
      recipient: true,
      status: true,
      attemptCount: true,
      nextAttemptAt: true,
      lastOutcome: true,
      sentAt: true,
      createdAt: true,
      payload: true,
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(NOTIFICATION_LOG_KIND, last.createdAt, last.id)
  );
  return {
    notifications: page.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        eventType: row.eventType,
        recipientKind: row.recipientKind,
        channel: row.channel,
        recipient: row.recipient,
        status: row.status,
        attemptCount: row.attemptCount,
        nextAttemptAt: row.nextAttemptAt,
        lastOutcome: row.lastOutcome,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
        summary: {
          orderNumber: payload.orderNumber ?? null,
          productName: payload.productName ?? null,
          toStatus: payload.toStatus ?? null,
        },
      };
    }),
    nextCursor,
  };
}
