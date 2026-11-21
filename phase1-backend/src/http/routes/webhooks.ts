/**
 * ق-182 — the door the mail provider knocks on.
 *
 * Unauthenticated by nature and guarded by signature instead: every delivery
 * from Resend carries Svix headers over the raw body, and a request that does
 * not verify is refused before it is parsed as anything. With no secret
 * configured the door answers 503 rather than silently accepting — a webhook
 * that "works" without verification is a way to unsubscribe anyone by name.
 */
import type { Express, Request } from "express";
import { asyncRoute } from "../shared.js";
import { HttpError } from "../../auth/auth.errors.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import {
  listComplaints,
  recordResendComplaint,
  verifyResendSignature,
} from "../../notifications/resend-webhook.js";
import { parseOrThrow } from "../validate.js";
import { resendEventSchema } from "../schemas/webhooks.schema.js";

type RawBodyRequest = Request & { rawBody?: Buffer };

export function registerWebhookRoutes(app: Express) {
  app.post(
    "/webhooks/resend",
    asyncRoute(async (request, response) => {
      const secret = process.env.CODIQ_RESEND_WEBHOOK_SECRET?.trim();
      if (!secret)
        throw new HttpError(
          503,
          "WEBHOOK_NOT_CONFIGURED",
          "CODIQ_RESEND_WEBHOOK_SECRET is not set; the Resend webhook is disabled."
        );
      const raw = (request as RawBodyRequest).rawBody;
      const id = request.header("svix-id") ?? "";
      const timestamp = request.header("svix-timestamp") ?? "";
      const signature = request.header("svix-signature") ?? "";
      if (
        !raw ||
        !id ||
        !timestamp ||
        !signature ||
        !verifyResendSignature({ secret, id, timestamp, signature, rawBody: raw })
      ) {
        throw new HttpError(
          401,
          "WEBHOOK_SIGNATURE_INVALID",
          "The webhook signature did not verify."
        );
      }
      const body = parseOrThrow(resendEventSchema, request.body ?? {});
      if (body.type !== "email.complained") {
        response.status(202).json({ ignored: true, type: body.type });
        return;
      }
      const outcome = await recordResendComplaint({
        id,
        to: body.data?.to,
        note: body.data?.subject ?? null,
      });
      response.status(202).json(outcome);
    })
  );

  // The reader. Compliance is the platform's, so it rides merchants.manage:
  // whoever oversees merchants sees which of them draws complaints.
  app.get(
    "/platform/messaging/complaints",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "merchants.manage");
      response.status(200).json(await listComplaints(request.query.limit, request.query.cursor));
    })
  );
}
