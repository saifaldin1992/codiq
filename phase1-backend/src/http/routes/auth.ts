import type { Express } from "express";
import { HttpError } from "../../auth/auth.errors.js";
import { loginMerchant, loginPlatformOwner, loginStaff, registerPlatformOwner } from "../../auth/auth.service.js";
import { loginPlatformStaff } from "../../services/platform-staff.service.js";
import { consumeStorefrontRateLimit, refundStorefrontRateLimit } from "../../services/storefront.service.js";
import { parseOrThrow } from "../validate.js";
import { loginPlatformStaffSchema } from "../schemas/platform-staff.schema.js";
import { loginMerchantSchema, loginPlatformOwnerSchema, loginStaffSchema, registerPlatformOwnerSchema } from "../schemas/auth.schema.js";
import { asyncRoute, requireTrustedWriteOrigin, setWebSession } from "../shared.js";

import { clientIp } from "../client-ip.js";
export function registerAuthRoutes(app: Express) {
  // Platform-owner registration is a bootstrap-only surface: closed unless
  // CODIQ_ALLOW_OWNER_REGISTRATION=true (CI/tests or a deliberate bootstrap window).
  app.post("/auth/platform/register", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    if (process.env.CODIQ_ALLOW_OWNER_REGISTRATION !== "true") {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.");
    }
    response.status(201).json({ account: await registerPlatformOwner(parseOrThrow(registerPlatformOwnerSchema, request.body ?? {})) });
  }));
  app.post("/auth/platform/login", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await consumeStorefrontRateLimit({ scope: "dashboard_login", rawKey: `platform:${clientIp(request)}`, limit: 30, windowMs: 10 * 60 * 1000 });
    const body = parseOrThrow(loginPlatformOwnerSchema, request.body ?? {});
    const session = await loginPlatformOwner({ email: body.email, password: body.password, totpCode: body.totpCode });
    setWebSession(response, session.accessToken);
    response.status(200).json(session);
  }));
  // ق-183: `POST /auth/merchant/register` was deleted. It was a second door into
  // one act that skipped the self-registration policy and the approval queue;
  // the public path is /public/merchants/register, and tests create merchants
  // through the service in process (tests/helpers/register-merchant.ts).
  // P27-21 — sign in by IDENTITY, not by store address. The old
  // `/auth/merchant/stores/:storeSlug/login` is gone rather than kept beside it:
  // two doors into one act, with different meanings, is debt that gets forgotten.
  //
  // The rate-limit key lost its `storeSlug` segment, and that TIGHTENS it. The
  // slug was attacker-controlled input, so changing one character minted a fresh
  // bucket and the limit could be walked around entirely. Keyed on the address
  // alone it does what it was written to do. A second bucket keyed on the
  // identifier was considered and refused: it would let a stranger lock a known
  // account out of its own door with ten deliberate failures.
  app.post("/auth/merchant/login", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const rateKey = { scope: "dashboard_login", rawKey: `merchant:${clientIp(request)}` };
    await consumeStorefrontRateLimit({ ...rateKey, limit: 30, windowMs: 10 * 60 * 1000 });
    const credentials = parseOrThrow(loginMerchantSchema, request.body ?? {});
    const session = await loginMerchant({ identifier: credentials.identifier, password: credentials.password });
    // ع-2: the budget exists to slow GUESSING, so a correct sign-in gives its
    // attempt back. Dropping the store slug from the key closed a real bypass
    // but left one bucket per ADDRESS — and on Iraqi mobile networks many
    // merchants share one. Without this refund, thirty honest sign-ins lock out
    // the thirty-first, with no attacker involved.
    await refundStorefrontRateLimit(rateKey);
    setWebSession(response, session.accessToken);
    response.status(200).json(session);
  }));
  // ق-194 — the same bypass the merchant door above documents removing, LEFT HERE.
  //
  // The key was `staff:${storeSlug}:${ip}` and `:storeSlug` is a free path
  // segment nobody resolves before this line. So an attacker incremented one
  // character per request, landed in a brand-new bucket every time, and NEVER saw
  // a 429: unbounded password guessing against any staff account on the platform,
  // from one address. The 404-vs-401 split below even confirms a correct password
  // without the attacker ever knowing a real slug — `loginStaff` compares the
  // password BEFORE it looks up the membership.
  //
  // It was also a free platform-wide denial of service. `loginStaff` runs an
  // unconditional bcrypt-12 compare against ABSENT_IDENTITY_HASH for an unknown
  // email — the anti-enumeration measure of 19-د — and at the time the hashing
  // library was pure JS, so every guess bought ~500 ms of BLOCKING work on the
  // single-threaded event loop: a couple of connections stalled the API, both
  // dashboards and every storefront. D-36 (ق-244) moved the compare onto the
  // threadpool; the limiter stays, because CPU on the threadpool is still CPU.
  //
  // Keyed on the address alone it does what it was written to do. The refund is
  // the merchant door's ع-2 reasoning applied here for the same reason: one
  // bucket per ADDRESS, and on Iraqi mobile networks a whole shop shares one, so
  // without it thirty honest sign-ins lock out the thirty-first.
  app.post("/auth/staff/stores/:storeSlug/login", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const rateKey = { scope: "dashboard_login", rawKey: `staff:${clientIp(request)}` };
    await consumeStorefrontRateLimit({ ...rateKey, limit: 30, windowMs: 10 * 60 * 1000 });
    const body = parseOrThrow(loginStaffSchema, request.body ?? {});
    const session = await loginStaff({ ...body, storeSlug: request.params.storeSlug });
    await refundStorefrontRateLimit(rateKey);
    setWebSession(response, session.accessToken);
    response.status(200).json(session);
  }));
  // 19-ب (ق-143): the platform-staff door. Deliberately UNDER the
  // `/auth/platform` prefix — the demo guard blocks that prefix wholesale, so
  // this door vanishes from the demo the same way the owner's does; a
  // hyphenated sibling path would NOT be covered.
  app.post("/auth/platform/staff/login", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await consumeStorefrontRateLimit({ scope: "dashboard_login", rawKey: `platform-staff:${clientIp(request)}`, limit: 30, windowMs: 10 * 60 * 1000 });
    const body = parseOrThrow(loginPlatformStaffSchema, request.body ?? {});
    const session = await loginPlatformStaff(body);
    setWebSession(response, session.accessToken);
    response.status(200).json(session);
  }));
}
