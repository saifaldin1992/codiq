/**
 * Phase 19-أ — sign out, and manage what is signed in as you.
 *
 * ONE SET OF ROUTES FOR ALL FOUR IDENTITIES. The token already says which kind
 * it is, so `requireAnySession` reads it and the service picks the right table.
 * Four near-identical route blocks would be four places to forget a fix.
 *
 * Every route here acts on the CALLER'S OWN sessions and nothing else. There is
 * deliberately no "end this merchant's sessions" for an owner: that is an act
 * upon another person's account, it belongs with the account-lifecycle work, and
 * it needs an audit trail this file does not write.
 */
import type { Express } from "express";
import { asyncRoute, bearerToken, clearWebSession, requireTrustedWriteOrigin } from "../shared.js";
import { verifyAnySession } from "../../auth/identity.js";
import { endCurrentSession, listSessions, revokeOtherSessions, revokeSession } from "../../services/session.service.js";

export function registerSessionRoutes(app: Express) {
  app.get("/auth/sessions", asyncRoute(async (request, response) => {
    const claims = await verifyAnySession(bearerToken(request));
    response.status(200).json(await listSessions(claims));
  }));

  app.post("/auth/logout", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await verifyAnySession(bearerToken(request));
    await endCurrentSession(claims);
    // The cookie goes too. Revoking the row without clearing the cookie leaves
    // the browser sending a dead token on every request — every one a 401 the
    // person cannot explain.
    clearWebSession(response);
    response.status(204).end();
  }));

  app.delete("/auth/sessions/:sessionId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await verifyAnySession(bearerToken(request));
    await revokeSession(claims, request.params.sessionId);
    response.status(204).end();
  }));

  app.post("/auth/sessions/revoke-others", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const claims = await verifyAnySession(bearerToken(request));
    response.status(200).json(await revokeOtherSessions(claims));
  }));
}
