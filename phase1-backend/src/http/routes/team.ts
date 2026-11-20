import type { Express } from "express";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import { requireStoreActor, requireStoreStaff } from "../../auth/staff-permissions.js";
import { createStoreStaff, listStoreTeam, removeStoreMembership, restoreStoreMembership, setMembershipOverrides, updateStoreMembership } from "../../services/staff.service.js";
import { createStoreStaffSchema, membershipOverridesSchema, updateStoreMembershipSchema } from "../schemas/team.schema.js";
import { parseOrThrow } from "../validate.js";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";

export function registerTeamRoutes(app: Express) {
  app.get("/staff/stores/:storeSlug/session", asyncRoute(async (request, response) => {
    // Audit 14-ب: the probe answers even while the password is the merchant's
    // choice, so the dashboard can load and send the employee to «الأمان».
    const context = await requireStoreStaff(request, { allowPasswordChangePending: true });
    response.status(200).json({
      staff: context.staff,
      ...(context.mustChangePassword ? { mustChangePassword: true } : {}),
      store: { slug: context.store.slug },
      membership: { id: context.membership.id, roleCode: context.membership.roleCode, permissionVersion: context.membership.permissionVersion },
      permissions: Array.from(context.permissions).sort(),
    });
  }));
  app.get("/merchant/stores/:storeSlug/team", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "team.manage");
    response.status(200).json({ storeSlug: store.slug, team: await listStoreTeam(store.id) });
  }));
  app.post("/merchant/stores/:storeSlug/team", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "team.manage");
    await assertCapabilityAvailable("team.staff", store);
    response.status(201).json(await createStoreStaff(store.id, parseOrThrow(createStoreStaffSchema, request.body ?? {})));
  }));
  app.patch("/merchant/stores/:storeSlug/team/:membershipId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "team.manage");
    await assertCapabilityAvailable("team.staff", store);
    const input = parseOrThrow(updateStoreMembershipSchema, request.body ?? {});
    response.status(200).json({ membership: await updateStoreMembership(store.id, request.params.membershipId, input) });
  }));
  app.put("/merchant/stores/:storeSlug/team/:membershipId/overrides", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "team.manage");
    await assertCapabilityAvailable("team.staff", store);
    const input = parseOrThrow(membershipOverridesSchema, request.body ?? {});
    response.status(200).json({ membership: await setMembershipOverrides(store.id, request.params.membershipId, input) });
  }));
  // PG-2: «إزالة من الفريق» — distinct from the PATCH above, which is «إيقاف».
  // Appended after every pre-existing route so the global registration order is
  // untouched; DELETE on this path was not previously registered at all.
  app.delete("/merchant/stores/:storeSlug/team/:membershipId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "team.manage");
    response.status(200).json(await removeStoreMembership(store.id, request.params.membershipId, actor));
  }));
  // ق-174: kept. No screen calls this — DeleteConfirmSheet restores through the
  // trash route — but pg2 T12 asserts it, so it is an API-only act until the
  // owner decides to retire it together with that assertion. Listed in
  // surface.legacy.json, not exempted: the decision is still open.
  app.post("/merchant/stores/:storeSlug/team/:membershipId/restore", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "team.manage");
    await assertCapabilityAvailable("team.staff", store);
    response.status(200).json({ membership: await restoreStoreMembership(store.id, request.params.membershipId, actor) });
  }));
}
