/**
 * Phase 19-أ — the security actions every identity has on its own account.
 *
 * ONE ROUTE FOR ALL FOUR KINDS, like the session routes beside it: the token
 * already says which kind it is, so the service picks the right table. Four
 * near-identical blocks would be four places to forget a fix.
 *
 * Everything here acts on the CALLER'S OWN account. Setting someone else's
 * password is an act upon another person's account — it belongs with the
 * account-lifecycle work and needs an audit trail this file does not write.
 */
import type { Express } from "express";
import { asyncRoute, bearerToken, requireTrustedWriteOrigin } from "../shared.js";
import { verifyAnySession } from "../../auth/identity.js";
import { parseOrThrow } from "../validate.js";
import { changePasswordSchema } from "../schemas/password.schema.js";
import {
  consumePasswordResetSchema,
  inspectPasswordResetSchema,
  requestPasswordResetSchema,
} from "../schemas/password-reset.schema.js";
import { changeOwnPassword } from "../../services/password.service.js";
import {
  consumePasswordReset,
  inspectPasswordReset,
  requestPasswordReset,
} from "../../services/password-reset.service.js";

import { clientIp } from "../client-ip.js";
export function registerAccountSecurityRoutes(app: Express) {
  app.post(
    "/auth/password",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await verifyAnySession(bearerToken(request));
      const body = parseOrThrow(changePasswordSchema, request.body ?? {});
      // The count of ended sessions comes back so the screen can say what actually
      // happened — "أُنهيت 3 جلسات أخرى" is evidence; a silent 204 is a promise.
      response.status(200).json(await changeOwnPassword(claims, body));
    })
  );

  // ==========================================================================
  // PR-1 — «استعادة كلمة السر». The three doors below take NO session: the
  // person cannot sign in, which is the entire situation.
  // ==========================================================================

  // 202 ALWAYS, with the same body for an address that exists and one that does
  // not — see the service header. The ceilings (per address AND per IP) live in
  // the service so no future caller can reach the mint without them, and so
  // they are consumed before any lookup runs.
  app.post(
    "/auth/password/reset/request",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const body = parseOrThrow(requestPasswordResetSchema, request.body ?? {});
      response
        .status(202)
        .json(
          await requestPasswordReset({ kind: body.kind, email: body.email, ip: clientIp(request) })
        );
    })
  );

  // A POST rather than a GET, and the token in the BODY rather than the path:
  // a secret in a URL lands in every access log and `Referer` between the
  // browser and here. It spends nothing — it exists so a person meeting a dead
  // link is told so before he chooses a new password and types it twice.
  app.post(
    "/auth/password/reset/inspect",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const body = parseOrThrow(inspectPasswordResetSchema, request.body ?? {});
      response.status(200).json(await inspectPasswordReset(body.token));
    })
  );

  // ONE consume door for all five identities: the token itself carries which
  // account it belongs to, so a second door would only be a second place to
  // forget the session revoke. It answers `redirectTo` — the sign-in page for
  // that identity — because it deliberately does NOT sign him in; see the
  // service header on the second factor.
  app.post(
    "/auth/password/reset/consume",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const body = parseOrThrow(consumePasswordResetSchema, request.body ?? {});
      response
        .status(200)
        .json(
          await consumePasswordReset({
            token: body.token,
            newPassword: body.newPassword,
            ip: clientIp(request),
          })
        );
    })
  );
}
