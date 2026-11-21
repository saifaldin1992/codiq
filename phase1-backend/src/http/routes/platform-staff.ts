/**
 * 19-ب (ق-143) — the platform-staff surface.
 *
 * Registered LAST in app.ts (the order warning at app.ts:49-51): every route
 * here is new — `/platform/staff/*` and `/platform/audit-events` share no
 * pattern with any pre-existing registration, so nothing above can be
 * shadowed and nothing here shadows.
 *
 * The team routes are OWNER-ONLY on purpose: hiring, firing, role changes and
 * factor resets are acts upon someone else's account, and no permission code
 * exists that grants them — «مشرف عام» included.
 */
import type { Express } from "express";
import { requirePlatformActor, requirePlatformStaff } from "../../auth/platform-permissions.js";
import {
  createPlatformStaff,
  listPlatformTeam,
  removePlatformStaff,
  resetPlatformStaffTotp,
  setPlatformStaffOverrides,
  updatePlatformStaff,
} from "../../services/platform-staff.service.js";
import {
  beginPlatformStaffTotpEnrolment,
  confirmPlatformStaffTotpEnrolment,
} from "../../services/platform-staff-totp.service.js";
import { listPlatformAuditEvents } from "../../services/platform-audit.service.js";
import { parseOrThrow } from "../validate.js";
import { secondFactorSchema } from "../schemas/totp.schema.js";
import {
  createPlatformStaffSchema,
  platformStaffOverridesSchema,
  updatePlatformStaffSchema,
} from "../schemas/platform-staff.schema.js";
import { asyncRoute, requirePlatformOwner, requireTrustedWriteOrigin } from "../shared.js";

export function registerPlatformStaffRoutes(app: Express) {
  // ---------- the staff member's own surface ----------
  // Reachable BEFORE enrolment on purpose: this is the shell's bootstrap read,
  // and `totpEnrolled` is exactly the bit it needs to decide whether to render
  // the enrolment screen. Gating it behind the enrolment wall would strand an
  // unenrolled member on a dead failure page with no way to reach the two
  // enrolment routes. It leaks nothing beyond identity + "enrolment pending";
  // every WORK route stays walled by the default gate.
  app.get(
    "/platform/staff/session",
    asyncRoute(async (request, response) => {
      const context = await requirePlatformStaff(request, { allowUnenrolled: true });
      response.status(200).json({
        staff: context.staff,
        roleCode: context.roleCode,
        permissionVersion: context.permissionVersion,
        permissions: Array.from(context.permissions).sort(),
        totpEnrolled: context.totpEnrolled,
      });
    })
  );

  // The ONLY two routes reachable before enrolment (ق-124): a pre-enrolment
  // session exists to finish enrolment and for nothing else.
  app.post(
    "/platform/staff/security/totp/begin",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const context = await requirePlatformStaff(request, { allowUnenrolled: true });
      response.status(200).json(await beginPlatformStaffTotpEnrolment(context.staff.id));
    })
  );
  app.post(
    "/platform/staff/security/totp/confirm",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const context = await requirePlatformStaff(request, { allowUnenrolled: true });
      const { code } = parseOrThrow(secondFactorSchema, request.body ?? {});
      response.status(200).json(await confirmPlatformStaffTotpEnrolment(context.staff.id, code));
    })
  );

  // ---------- owner-only team management ----------
  app.get(
    "/platform/staff/team",
    asyncRoute(async (request, response) => {
      await requirePlatformOwner(request);
      response.status(200).json({ team: await listPlatformTeam() });
    })
  );
  app.post(
    "/platform/staff/team",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requirePlatformOwner(request);
      const body = parseOrThrow(createPlatformStaffSchema, request.body ?? {});
      response
        .status(201)
        .json(await createPlatformStaff({ kind: "platform_owner", id: claims.subjectId }, body));
    })
  );
  app.patch(
    "/platform/staff/team/:staffId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requirePlatformOwner(request);
      const body = parseOrThrow(updatePlatformStaffSchema, request.body ?? {});
      response
        .status(200)
        .json(
          await updatePlatformStaff(
            { kind: "platform_owner", id: claims.subjectId },
            request.params.staffId,
            body
          )
        );
    })
  );
  app.put(
    "/platform/staff/team/:staffId/overrides",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requirePlatformOwner(request);
      const body = parseOrThrow(platformStaffOverridesSchema, request.body ?? {});
      response
        .status(200)
        .json(
          await setPlatformStaffOverrides(
            { kind: "platform_owner", id: claims.subjectId },
            request.params.staffId,
            body
          )
        );
    })
  );
  app.delete(
    "/platform/staff/team/:staffId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requirePlatformOwner(request);
      response
        .status(200)
        .json(
          await removePlatformStaff(
            { kind: "platform_owner", id: claims.subjectId },
            request.params.staffId
          )
        );
    })
  );
  app.post(
    "/platform/staff/team/:staffId/totp/reset",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const claims = await requirePlatformOwner(request);
      response
        .status(200)
        .json(
          await resetPlatformStaffTotp(
            { kind: "platform_owner", id: claims.subjectId },
            request.params.staffId
          )
        );
    })
  );

  // ---------- the platform audit log ----------
  app.get(
    "/platform/audit-events",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "audit.view");
      response
        .status(200)
        .json(await listPlatformAuditEvents(request.query.limit, request.query.cursor));
    })
  );
}
