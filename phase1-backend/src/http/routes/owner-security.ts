/**
 * Phase 19-أ — the owner's own security surface (ق-123, ق-48).
 *
 * Every route here acts on the CALLER'S account and no one else's, so the guard
 * is simply "a platform-owner session". There is deliberately no route for one
 * owner to manage another's factor: that is an act upon someone else's account
 * and belongs with the platform-staff work, where it will need an audit trail.
 */
import type { Express } from "express";
import { asyncRoute, requirePlatformOwner, requireTrustedWriteOrigin } from "../shared.js";
import { parseOrThrow } from "../validate.js";
import { disableTotpSchema, secondFactorSchema } from "../schemas/totp.schema.js";
import { changeOwnerEmailSchema } from "../schemas/owner-account.schema.js";
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  totpStatus,
} from "../../services/owner-totp.service.js";
import { changeOwnerEmail, ownerAccount } from "../../services/owner-account.service.js";

export function registerOwnerSecurityRoutes(app: Express) {
  app.get("/platform/security/totp", asyncRoute(async (request, response) => {
    const claims = await requirePlatformOwner(request);
    response.status(200).json({ totp: await totpStatus(claims.subjectId) });
  }));

  app.post("/platform/security/totp/begin", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    // The secret is returned in the clear here on purpose: it is the thing the
    // authenticator app must receive, and there is no other way to deliver it.
    // It stays useless without the password that reached this route.
    response.status(200).json(await beginTotpEnrolment(claims.subjectId));
  }));

  app.post("/platform/security/totp/confirm", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    const { code } = parseOrThrow(secondFactorSchema, request.body ?? {});
    // The ONLY time the recovery codes are ever readable.
    response.status(200).json(await confirmTotpEnrolment(claims.subjectId, code));
  }));

  app.post("/platform/security/totp/disable", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    const { password } = parseOrThrow(disableTotpSchema, request.body ?? {});
    await disableTotp(claims.subjectId, password);
    response.status(204).end();
  }));

  /**
   * PC-1 — the owner's own sign-in email.
   *
   * It sits in this file rather than beside `POST /auth/password` because that
   * route serves all four identities from one table-picking service, and this one
   * does not: `platform_owners` is the only table involved, and widening it to
   * «any identity may change its email» would put a merchant's login address on
   * the same route with none of the notification work that act needs. That is a
   * later, larger phase; the owner's own address is what he asked for.
   *
   * The 409 for an address already claimed by another identity is not written
   * here — the database trigger raises it and `http/errors.ts` already maps it.
   */
  app.get("/platform/security/account", asyncRoute(async (request, response) => {
    const claims = await requirePlatformOwner(request);
    response.status(200).json({ account: await ownerAccount(claims.subjectId) });
  }));

  app.post("/platform/security/email", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await requirePlatformOwner(request);
    const body = parseOrThrow(changeOwnerEmailSchema, request.body ?? {});
    // The session is NOT revoked and no other session is ended — see the head of
    // owner-account.service.ts. He keeps working on the screen he is looking at.
    response.status(200).json(await changeOwnerEmail(claims.subjectId, body));
  }));
}
