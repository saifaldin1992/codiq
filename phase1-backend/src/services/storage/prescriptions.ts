/**
 * Object storage — prescriptions. Split verbatim from
 * product-image-storage.service.ts (review batch 3, ت-٤);
 * product-image-storage.service.ts re-exports what it always exported.
 */
import { randomUUID } from "node:crypto";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpError } from "../../auth/auth.errors.js";
import { validatePrescriptionImage } from "./validate.js";
import { s3Config, client, deleteStoredObjects } from "./bucket.js";

export async function putPrescriptionImage(
  storeId: string,
  orderId: string,
  file: Express.Multer.File
) {
  const detected = validatePrescriptionImage(file);
  const config = s3Config();
  const objectKey = `prescriptions/${storeId}/${orderId}/${randomUUID()}.${detected.extension}`;
  await client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: file.buffer,
      ContentType: detected.contentType,
      ContentLength: file.size,
    })
  );
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

/**
 * 19-د (ATTACK-SURFACE): before this existed, NOTHING in the codebase deleted an
 * object under the `prescriptions/` prefix. The only DeleteObjectCommand was
 * `deleteProductImageObjects`, whose single caller passes product-image keys —
 * so a prescription written to the bucket stayed there whatever happened to the
 * row that named it, and an object whose row was rolled back could not even be
 * FOUND again: the key existed nowhere else.
 *
 * Its caller today is the compensating path in `uploadOrderPrescription`. That
 * is the leak with an attacker behind it. Wiring it to an actual erasure
 * request — a customer asking to be forgotten, a store being removed — is a
 * policy the platform owner has not written yet, and is deliberately NOT
 * invented here.
 */
export async function deletePrescriptionObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "prescription-cleanup");
}

export async function getPrescriptionBytes(objectKey: string) {
  const config = s3Config();
  const object = await client(config).send(
    new GetObjectCommand({ Bucket: config.bucket, Key: objectKey })
  );
  if (!object.Body || !("transformToByteArray" in object.Body))
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested prescription could not be read.");
  return Buffer.from(await object.Body.transformToByteArray());
}
