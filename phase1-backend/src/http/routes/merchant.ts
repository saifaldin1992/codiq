import {
  dismissOnboarding,
  markOnboardingPreviewSeen,
  merchantOnboarding,
} from "../../services/merchant-onboarding.service.js";
import type { Express } from "express";
import { createTypedSession, verifyTypedSession } from "../../auth/identity.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import {
  listStoreCustomers,
  setCustomerActive,
} from "../../services/customer-directory.service.js";
import { customerAccessSchema } from "../schemas/customers.schema.js";
import { createManualCustomer } from "../../services/manual-provisioning.service.js";
import {
  createMerchantStore,
  listMerchantStores,
  merchantSessionView,
  merchantStoreForSwitch,
  renameMerchantStore,
} from "../../services/merchant-store.service.js";
import {
  createManualCustomerSchema,
  createMerchantStoreSchema,
  renameMerchantStoreSchema,
  switchMerchantStoreSchema,
} from "../schemas/merchant.schema.js";
import {
  scheduleStoreMaintenanceWindowSchema,
  setSettingSchema,
  setStoreStatusSchema,
} from "../schemas/availability.schema.js";
import {
  merchantAvailabilityNotices,
  merchantServicesView,
  setStoreStatusByMerchant,
  storeStatus,
} from "../../services/availability.service.js";
import {
  cancelStoreMaintenanceWindow,
  listMaintenanceWindows,
  scheduleStoreMaintenanceWindow,
} from "../../services/maintenance.service.js";
import { merchantConfigView, setMerchantSetting } from "../../services/config.service.js";
import { listSearchQuerySchema } from "../schemas/search.schema.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { parseOrThrow } from "../validate.js";
import {
  asyncRoute,
  bearerToken,
  requireMerchantStore,
  requireTrustedWriteOrigin,
  setWebSession,
  requireMerchantSession,
} from "../shared.js";

export function registerMerchantRoutes(app: Express) {
  /**
   * ق-226 — the merchant shell asks who is looking BEFORE it draws.
   *
   * This shell was the only one of four that rendered for anybody who typed the
   * URL. Nothing leaked — every screen's own request was refused by the server —
   * but the result was worse than a refusal: a signed-out merchant got a full
   * dashboard whose every card said «تعذر التحميل», and a store employee or a
   * platform owner (D-88: one cookie, five identities) landed on the merchant's
   * chrome instead of his own door. ق-171 fixed exactly this for the owner and
   * the staff shells; this is the merchant's missing probe.
   *
   * Deliberately NOT behind `requireMerchantSession`: a merchant still holding
   * the password his provisioner typed (ق-218) must be able to bootstrap the
   * shell that renders the ONE screen he is allowed — the same reason
   * `/platform/staff/session` is reachable before TOTP enrolment. It answers
   * with `mustChangePassword` so the shell knows to send him there, and it
   * carries nothing beyond identity: no orders, no money, no customers.
   */
  app.get(
    "/merchant/session",
    asyncRoute(async (request, response) => {
      const claims = await verifyTypedSession(bearerToken(request), "merchant");
      // `merchant_sessions.store_id` is NOT NULL and `createTypedSession` refuses a
      // store-less merchant session, so the claim is always there; the fallback
      // keeps the type honest rather than asserting it away.
      const merchant = await merchantSessionView(claims.subjectId, claims.storeId ?? "");
      response.status(200).json(merchant);
    })
  );
  // PG-8 (ق-76) — the new merchant's first path. Four of its five steps are read
  // from real data, so it can never claim he did something he has since undone.
  app.get(
    "/merchant/stores/:storeSlug/onboarding",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      response.status(200).json({ onboarding: await merchantOnboarding(store.slug, store.id) });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/onboarding/preview-seen",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.view");
      await markOnboardingPreviewSeen(store.id);
      response.status(200).json({ onboarding: await merchantOnboarding(store.slug, store.id) });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/onboarding/dismiss",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.view");
      await dismissOnboarding(store.id);
      response.status(200).json({ onboarding: await merchantOnboarding(store.slug, store.id) });
    })
  );
  app.get(
    "/merchant/stores",
    asyncRoute(async (request, response) => {
      const claims = await requireMerchantSession(request);
      response.status(200).json({ stores: await listMerchantStores(claims.subjectId) });
    })
  );
  app.post(
    "/merchant/stores/switch",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requireMerchantSession(request);
      const { storeSlug } = parseOrThrow(switchMerchantStoreSchema, request.body ?? {});
      const store = await merchantStoreForSwitch(claims.subjectId, storeSlug);
      const accessToken = await createTypedSession("merchant", claims.subjectId, store.id);
      setWebSession(response, accessToken);
      // P27-21: the token travels in the BODY as well as the cookie, exactly as
      // every other session-issuing route does. Without it a bearer client could
      // not switch stores at all — and switching is now the ordinary path for a
      // merchant with more than one store, not a rare corner.
      response
        .status(200)
        .json({
          store,
          accessToken,
          redirectTo: `/merchant/stores/${encodeURIComponent(store.slug)}/dashboard`,
        });
    })
  );
  app.post(
    "/merchant/stores",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requireMerchantSession(request);
      const { name, slug } = parseOrThrow(createMerchantStoreSchema, request.body ?? {});
      const store = await createMerchantStore(claims.subjectId, { name, slug });
      const accessToken = await createTypedSession("merchant", claims.subjectId, store.id);
      setWebSession(response, accessToken);
      response
        .status(201)
        .json({
          store,
          redirectTo: `/merchant/stores/${encodeURIComponent(store.slug)}/dashboard`,
        });
    })
  );
  // Manual customer creation was registered directly after the store-management
  // routes in the pre-split app.ts; it stays here to preserve registration order.
  app.post(
    "/merchant/stores/:storeSlug/customers/manual",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      // D-64 (ق-244): a write asks for a write permission. `customers.view` still
      // opens the directory below; it no longer opens this.
      const { store } = await requireStoreActor(request, "customers.manage");
      // 19-ج: three named fields instead of the whole body spread — `storeId` has
      // always come from the resolved store actor, and now it is the only way in.
      const { fullName, email, phone } = parseOrThrow(
        createManualCustomerSchema,
        request.body ?? {}
      );
      response
        .status(201)
        .json({
          customer: await createManualCustomer({ storeId: store.id, fullName, email, phone }),
        });
    })
  );
  // Menus pass A: the merchant and staff «العملاء» pages read through the same
  // store-actor guard; segments and search are resolved entirely on the server.
  // ق-179: the block. `settings.manage`, because deciding who may buy here is
  // the store's policy, not its daily traffic — the same code as its other rules.
  app.patch(
    "/merchant/stores/:storeSlug/customers/:customerId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(customerAccessSchema, request.body ?? {});
      response
        .status(200)
        .json({
          customer: await setCustomerActive(store.id, request.params.customerId, actor, body),
        });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/customers",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "customers.view");
      // PG-6 (ق-74): the directory's `q` gains the two-character floor every
      // other search surface enforces — it had none, so a single character swept
      // the store — plus the phone gate and the split-column engine search
      // inside the service.
      const { q } = parseOrThrow(listSearchQuerySchema, { q: request.query.q });
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listStoreCustomers(store.id, { ...request.query, q })),
        });
    })
  );
  // Menus pass A: rename is merchant-only (not staff) and never touches the slug.
  app.patch(
    "/merchant/stores/:storeSlug",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const store = await requireMerchantStore(request);
      const { name } = parseOrThrow(renameMerchantStoreSchema, request.body ?? {});
      response
        .status(200)
        .json({ store: await renameMerchantStore(store.id, { name }, store.slug) });
    })
  );
  // ---------- MD-1: «وضع الإجازة». A dedicated pair of endpoints behind
  // settings.manage — the long-standing `GET /merchant/stores` summary shape is
  // deliberately left byte-identical. Appended after every pre-existing route.
  // ق-249 (المرحلة 29): the MD-1 vacation switch became one named STATUS —
  // active | paused (the old vacation: browsing open, checkout closed) | maintenance
  // (closed to shoppers, the dashboard stays) | closed. `suspended` is the
  // platform's word and this door refuses it.
  app.get(
    "/merchant/stores/:storeSlug/status",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      response.status(200).json({ storeSlug: store.slug, ...(await storeStatus(store.id)) });
    })
  );
  app.put(
    "/merchant/stores/:storeSlug/status",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(setStoreStatusSchema, request.body ?? {});
      response
        .status(200)
        .json({ storeSlug: store.slug, ...(await setStoreStatusByMerchant(store.id, body)) });
    })
  );
  // The merchant's view of the control layer: every service and capability with its
  // effective state HERE and the reason — so «معطّلة من المنصّة» is never a guess.
  app.get(
    "/merchant/stores/:storeSlug/services",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          services: await merchantServicesView(store.merchantId, store.id),
        });
    })
  );
  // ق-250: the merchant's own scheduled maintenance — the shop closes and reopens on the clock — and
  // the notices the platform has for him (running / upcoming windows, open incidents).
  app.get(
    "/merchant/stores/:storeSlug/maintenance-windows",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      const query = parseOrThrow(paginationQuerySchema, request.query ?? {});
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listMaintenanceWindows(query.limit, query.cursor, {
            storeId: store.id,
            live: request.query.live === "true",
          })),
        });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/maintenance-windows",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(scheduleStoreMaintenanceWindowSchema, request.body ?? {});
      response
        .status(201)
        .json({
          storeSlug: store.slug,
          window: await scheduleStoreMaintenanceWindow(
            store,
            { kind: actor.kind as "merchant" | "staff", id: actor.id },
            body
          ),
        });
    })
  );
  app.delete(
    "/merchant/stores/:storeSlug/maintenance-windows/:id",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "settings.manage");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          window: await cancelStoreMaintenanceWindow(
            store.id,
            { kind: actor.kind as "merchant" | "staff", id: actor.id },
            request.params.id
          ),
        });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/availability/notices",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "orders.view");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await merchantAvailabilityNotices(store.merchantId, store.id)),
        });
    })
  );
  // ق-251: the configuration hierarchy as the merchant reads it — every setting with its effective value, who
  // decided it, and the whole chain; and his own level, refused by name when it would loosen what sits above.
  app.get(
    "/merchant/stores/:storeSlug/config",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          settings: await merchantConfigView(store.merchantId, store.id),
        });
    })
  );
  app.put(
    "/merchant/stores/:storeSlug/config/:code",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(setSettingSchema, request.body ?? {});
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          setting: await setMerchantSetting(
            store.merchantId,
            { kind: actor.kind as "merchant" | "staff", id: actor.id },
            request.params.code,
            body.value
          ),
        });
    })
  );
}
