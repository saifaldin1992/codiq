/**
 * A malformed identifier is the caller's mistake, whichever way it reached Postgres — moved out
 * of errors.ts (review batch 4, ت-٧).
 *
 *   · P2023 — a Prisma query was handed text that is not a uuid for a `@db.Uuid` column.
 *   · P2010 / 22P02 — the same mistake through a RAW query: a `${id}::uuid` cast of text that
 *     is not one. It was an unhandled 500 on a public route («يُشترى معه»).
 *
 * Both are 400 INVALID_IDENTIFIER.
 */
import { Prisma } from "@prisma/client";

export function malformedIdentifier(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const rawCast =
    error.code === "P2010" && (error.meta as { code?: unknown } | undefined)?.code === "22P02";
  if (error.code !== "P2023" && !rawCast) return null;
  return {
    status: 400,
    error: { code: "INVALID_IDENTIFIER", message: "أحد المعرّفات في الطلب غير صالح." },
    mapped: true,
  };
}
