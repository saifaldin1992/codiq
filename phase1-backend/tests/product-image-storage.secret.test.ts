import {
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

describe("product S3-compatible configuration", () => {
  it("authenticates to the configured product image bucket", async () => {
    const endpoint = process.env.PRODUCT_S3_ENDPOINT;
    const bucket = process.env.PRODUCT_S3_BUCKET;
    const accessKeyId = process.env.PRODUCT_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.PRODUCT_S3_SECRET_ACCESS_KEY;
    const region = process.env.PRODUCT_S3_REGION ?? "us-east-1";

    expect(endpoint).toBeTruthy();
    expect(bucket).toBeTruthy();
    expect(accessKeyId).toBeTruthy();
    expect(secretAccessKey).toBeTruthy();

    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle: process.env.PRODUCT_S3_FORCE_PATH_STYLE !== "false",
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    });
    await expect(client.send(new HeadBucketCommand({ Bucket: bucket! }))).resolves.toBeDefined();
    const verificationKey = `_verification/${randomUUID()}.txt`;
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: bucket!,
          Key: verificationKey,
          Body: "codiq product image storage verification",
          ContentType: "text/plain",
        })
      )
    ).resolves.toBeDefined();
    await expect(
      client.send(new DeleteObjectCommand({ Bucket: bucket!, Key: verificationKey }))
    ).resolves.toBeDefined();
  }, 20_000);
});
