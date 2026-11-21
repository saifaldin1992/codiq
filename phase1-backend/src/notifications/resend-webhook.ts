/**
 * ق-182 — complaints reach the table that was built for them.
 *
 * PG-3 created `notification_complaints` with an index, a migration and a
 * compliance clause (ق-69 names complaint tracking a condition of sending at
 * all) — and no writer, no reader, no route. The table stayed empty in
 * production while the platform sent mail. `recordUnsubscribe` even accepted
 * a `"complaint"` source that nothing passed.
 *
 * The owner chose the webhook over manual entry: manual entry never happens,
 * and compliance needs a number, not an intention. Resend signs every
 * delivery with Svix — `svix-id`, `svix-timestamp`, `svix-signature` — and
 * this module verifies that signature over the RAW body (a re-serialised
 * body is a different byte string and fails by design), then attributes the
 * complaint to the store that sent the message, records it, and suppresses
 * the address for that store. Redeliveries are the same event by id and are
 * absorbed, not doubled.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "../services/list-page.js";
import { normalizeEmail, recordUnsubscribe } from "./messaging-compliance.service.js";

export const RESEND_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Svix: `whsec_` + base64(secret); signature = base64(HMAC-SHA256(secret, `${id}.${ts}.${body}`)). */
export function verifyResendSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
  rawBody: Buffer;
  now?: number;
}): boolean {
  const secretPart = input.secret.startsWith("whsec_")
    ? input.secret.slice("whsec_".length)
    : input.secret;
  let key: Buffer;
  try {
    key = Buffer.from(secretPart, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.now ?? Date.now();
  if (Math.abs(now - ts * 1000) > RESEND_WEBHOOK_TOLERANCE_MS) return false;
  const expected = createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.`)
    .update(input.rawBody)
    .digest();
  // The header may carry several `v1,<sig>` pairs (key rotation); any one is enough.
  for (const candidate of input.signature.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || !value) continue;
    let given: Buffer;
    try {
      given = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export type ComplaintOutcome =
  | { recorded: true; storeSlug: string; email: string }
  | { recorded: false; reason: "duplicate" | "no_matching_message" | "no_recipient" };

/**
 * Attributes by RECIPIENT, because the outbox keeps the address it sent to and
 * not the provider's message id. The most recent email this platform sent to
 * that address is the one complained about — an approximation that errs, when
 * it errs, toward suppressing an address at a store that did mail it.
 */
export async function recordResendComplaint(event: {
  id: string;
  to: unknown;
  note?: string | null;
}): Promise<ComplaintOutcome> {
  const first = Array.isArray(event.to) ? event.to[0] : event.to;
  if (typeof first !== "string" || !first.trim())
    return { recorded: false, reason: "no_recipient" };
  const email = normalizeEmail(first);
  // ق-206: SENT rows only. Without the status filter a `skipped` or `pending`
  // row — a message that never left the building — was a candidate, and because
  // `sentAt` is NULL on such rows and Postgres sorts NULLS FIRST on DESC, every
  // never-sent row outranked every genuinely sent one. A shopper who had
  // unsubscribed at store A (leaving a skipped row there) and then reported
  // store B's mail as spam charged the complaint to A, which had mailed him
  // nothing, and B kept sending. The store blamed must be one that sent.
  const sent = await prisma.notificationOutbox.findFirst({
    where: {
      channel: "email",
      recipient: email,
      storeId: { not: null },
      status: "sent",
      sentAt: { not: null },
    },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, storeId: true, store: { select: { slug: true } } },
  });
  if (!sent?.storeId || !sent.store) return { recorded: false, reason: "no_matching_message" };
  try {
    await prisma.notificationComplaint.create({
      data: {
        storeId: sent.storeId,
        outboxId: sent.id,
        emailNormalized: email,
        note: event.note ?? null,
        providerEventId: event.id,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      return { recorded: false, reason: "duplicate" };
    throw error;
  }
  await recordUnsubscribe(sent.storeId, email, "complaint");
  return { recorded: true, storeSlug: sent.store.slug, email };
}

const COMPLAINTS_KIND = "platform.messaging.complaints";

export async function listComplaints(rawLimit: unknown, rawCursor: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(COMPLAINTS_KIND, rawCursor, {});
  const rows = await prisma.notificationComplaint.findMany({
    where: { ...keysetWhere("reportedAt", "desc", cursor) },
    orderBy: [{ reportedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      emailNormalized: true,
      note: true,
      reportedAt: true,
      providerEventId: true,
      store: { select: { slug: true, name: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(COMPLAINTS_KIND, last.reportedAt, last.id)
  );
  return {
    complaints: page.map((row) => ({
      id: row.id,
      email: row.emailNormalized,
      note: row.note,
      reportedAt: row.reportedAt,
      providerEventId: row.providerEventId,
      store: row.store,
    })),
    nextCursor,
  };
}
