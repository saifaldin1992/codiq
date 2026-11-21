/**
 * codiq phase 20B-1 — prescription-required products.
 *
 * The prescription lives OUTSIDE the checkout transaction (approved decision
 * §8.10): checkout only stamps `prescription_status = 'pending_upload'` on the
 * order when any locked product requires a prescription. The customer uploads
 * AFTER the order exists, through the existing S3 pipeline (magic-byte checks
 * unchanged), under keys `prescriptions/{storeId}/{orderId}/{uuid}`.
 *
 * Privacy: there is NO public route. Streaming is guarded — merchant/staff via
 * requireStoreActor("orders.view") (decision §8.12), the customer via order
 * ownership. Review (approve|reject) is guarded by orders.update; a rejection
 * re-opens the upload (decision §8.11). The state-machine gate itself
 * (new→processing refused until approved) lives in transitionOrderStatus.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import {
  deletePrescriptionObjects,
  getPrescriptionBytes,
  putPrescriptionImage,
} from "./product-image-storage.service.js";

export const ORDER_PRESCRIPTION_STATUSES = [
  "pending_upload",
  "pending_review",
  "approved",
  "rejected",
] as const;
export type OrderPrescriptionStatus = (typeof ORDER_PRESCRIPTION_STATUSES)[number];

function prescriptionMeta(row: {
  id: string;
  contentType: string;
  byteSize: number;
  reviewStatus: string;
  reviewedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    contentType: row.contentType,
    byteSize: row.byteSize,
    reviewStatus: row.reviewStatus,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

async function ownedOrder(storeId: string, customerId: string, orderId: string) {
  // Ownership scoping mirrors customerOrder: anything outside the pair is a plain 404 (IDOR-safe).
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    select: { id: true, prescriptionStatus: true },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");
  return order;
}

/** Customer upload — allowed only while the order is waiting for one (or after a rejection). */
export async function uploadOrderPrescription(
  storeId: string,
  customerId: string,
  orderId: string,
  file: Express.Multer.File | undefined
) {
  const order = await ownedOrder(storeId, customerId, orderId);
  if (order.prescriptionStatus === null)
    throw new HttpError(
      422,
      "PRESCRIPTION_NOT_REQUIRED",
      "This order does not require a prescription."
    );
  if (order.prescriptionStatus !== "pending_upload" && order.prescriptionStatus !== "rejected") {
    throw new HttpError(
      422,
      "PRESCRIPTION_ALREADY_SUBMITTED",
      "A prescription for this order is already under review or approved."
    );
  }
  if (!file)
    throw new HttpError(
      422,
      "INVALID_PRESCRIPTION_IMAGE",
      "A prescription image file is required."
    );
  // 19-د (ATTACK-SURFACE): the bytes are charged to a PLAN before they are
  // stored, exactly as `addProductImages` charges them. Prescriptions ride the
  // merchant's own bucket at the platform's cost and were charged to nobody at
  // all, so a shopper on any pharmacy store could push megabytes in for free
  // and no plan ever noticed. `merchantUsage` now counts them, which is what
  // makes this a limit rather than a check against a number that never moves.
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { merchantId: true },
  });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
  await assertWithinPlanLimit(
    prisma,
    store.merchantId,
    "max_image_storage_mb",
    Math.max(1, Math.ceil(file.size / (1024 * 1024))),
    "لرفع الوصفة"
  );
  // Magic-byte validation + S3 put happen BEFORE any database write, so a bad
  // file leaves the order untouched.
  const stored = await putPrescriptionImage(storeId, orderId, file);
  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      const created = await tx.orderPrescription.create({
        data: { storeId, orderId, customerId, ...stored },
      });
      // Guarded in-transaction: a racing upload (or a just-approved review) must
      // not flip an approved order back to pending_review.
      const updated = await tx.storeOrder.updateMany({
        where: { id: orderId, prescriptionStatus: { in: ["pending_upload", "rejected"] } },
        data: { prescriptionStatus: "pending_review" },
      });
      if (updated.count !== 1)
        throw new HttpError(
          409,
          "PRESCRIPTION_ALREADY_SUBMITTED",
          "A prescription for this order is already under review or approved."
        );
      return created;
    });
  } catch (error) {
    // 19-د: the object was written BEFORE the transaction (deliberately — §8.10
    // keeps a bad file out of the database), so a rolled-back transaction used
    // to leave it in the bucket with NOTHING pointing at it. The key existed
    // nowhere else once the row was gone, so no operator could even enumerate
    // the waste, let alone erase it.
    //
    // The 409 above is the attacker-timed way to reach this: N concurrent
    // uploads all read `pending_upload` off an unlocked snapshot, all store
    // 5 MB, one wins the guarded updateMany and the rest roll back — 5 MB each
    // of permanently orphaned data per losing request. But the compensation is
    // not written for the race; it is written for the ORDINARY failure. A pool
    // timeout or a dropped connection after the PUT orphans an object on the
    // happy path too, and did.
    await deletePrescriptionObjects([stored.objectKey]);
    throw error;
  }
  return { prescription: prescriptionMeta(row), prescriptionStatus: "pending_review" as const };
}

async function latestPrescriptionRow(storeId: string, orderId: string) {
  const row = await prisma.orderPrescription.findFirst({
    where: { storeId, orderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!row)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "No prescription has been uploaded for this order."
    );
  return row;
}

/** Customer streaming — order ownership is the guard. */
export async function customerPrescriptionFile(
  storeId: string,
  customerId: string,
  orderId: string
) {
  await ownedOrder(storeId, customerId, orderId);
  const row = await latestPrescriptionRow(storeId, orderId);
  return { contentType: row.contentType, bytes: await getPrescriptionBytes(row.objectKey) };
}

/** Merchant/staff streaming — the route guards with requireStoreActor("orders.view"). */
export async function merchantPrescriptionFile(storeId: string, orderId: string) {
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId },
    select: { id: true },
  });
  if (!order)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested order was not found in this store."
    );
  const row = await latestPrescriptionRow(storeId, orderId);
  return { contentType: row.contentType, bytes: await getPrescriptionBytes(row.objectKey) };
}

/**
 * Merchant/staff review — the route guards with requireStoreActor("orders.update").
 * approved closes the gate for new→processing; rejected re-opens the upload.
 */
export async function reviewOrderPrescription(
  storeId: string,
  actor: { kind: "merchant" | "staff"; id: string },
  orderId: string,
  rawDecision: unknown
) {
  if (rawDecision !== "approved" && rawDecision !== "rejected") {
    throw new HttpError(
      422,
      "INVALID_PRESCRIPTION_DECISION",
      "decision must be approved or rejected."
    );
  }
  const decision = rawDecision;
  return prisma.$transaction(async (tx) => {
    const order = await tx.storeOrder.findFirst({
      where: { id: orderId, storeId },
      select: { id: true, prescriptionStatus: true },
    });
    if (!order)
      throw new HttpError(
        404,
        "RESOURCE_NOT_FOUND",
        "The requested order was not found in this store."
      );
    if (order.prescriptionStatus !== "pending_review") {
      throw new HttpError(
        422,
        "PRESCRIPTION_NOT_REVIEWABLE",
        "Only a prescription pending review can be approved or rejected."
      );
    }
    const latest = await tx.orderPrescription.findFirst({
      where: { storeId, orderId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (latest) {
      await tx.orderPrescription.update({
        where: { id: latest.id },
        data: {
          reviewStatus: decision,
          reviewedByKind: actor.kind,
          reviewedById: actor.id,
          reviewedAt: new Date(),
        },
      });
    }
    await tx.storeOrder.update({ where: { id: orderId }, data: { prescriptionStatus: decision } });
    return { orderId, prescriptionStatus: decision };
  });
}
