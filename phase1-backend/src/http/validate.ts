/**
 * Phase 19-ج — one validation layer, one error shape (ق-49, settles D-14).
 *
 * WHAT THIS REPLACES. Eighty-eight write endpoints each check their own input by
 * hand, and each invents its own refusal: `INVALID_INPUT`, `INVALID_REVIEW_BODY`,
 * `INVALID_MONTH`, `INVALID_LOYALTY_POINTS`. Some say which field was wrong,
 * most do not. A client cannot map that to a form field, and a translator cannot
 * find the strings, which is why this is a stated prerequisite for the i18n and
 * payments phases rather than a tidying exercise.
 *
 * WHAT IT DOES NOT DO. It does not replace business rules. `zod` answers "is
 * this the right SHAPE" — an integer between 1 and 5, a non-empty string under
 * 2000 characters. It cannot answer "does this customer have a completed order
 * containing this product", and pretending otherwise would move real decisions
 * into a schema where nobody looks for them. Shape here; meaning stays in the
 * service.
 *
 * THE ERROR SHAPE IS ADDITIVE. A failure is still `422` with
 * `{ error: { code, message } }`, byte-identical in those two fields to what
 * every existing test asserts — plus a `fields` array naming each bad path and
 * its own code. Existing clients see what they always saw; new ones can point at
 * the field.
 */
import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { HttpError } from "../auth/auth.errors.js";

export interface FieldIssue {
  /** Dotted path, e.g. `address.governorate` or `items.0.quantity`. */
  path: string;
  /**
   * A stable, translatable code — `too_small`, `invalid_type`, `too_big` — taken
   * from zod rather than invented here, so the set is closed and a translator
   * can enumerate it.
   */
  code: string;
  message: string;
}

/**
 * Turns a zod failure into the platform's error. `details.fields` is where the
 * per-field information lives; `errorHandler` already spreads `details` into the
 * response body (PG-2 added that for restore conflicts), so nothing in the error
 * pipeline needs to change to carry it.
 */
export function validationError(issues: FieldIssue[]): HttpError {
  const first = issues[0];
  return new HttpError(
    422,
    "VALIDATION_FAILED",
    // The message names the FIRST offending field rather than concatenating all
    // of them: a wall of text is not more useful than a sentence, and the full
    // list is in `fields` for any client that wants it.
    first ? `${first.message} (${first.path})` : "المُدخلات غير صالحة.",
    { fields: issues }
  );
}

function issuesFrom(error: unknown): FieldIssue[] {
  const zodIssues = (
    error as { issues?: Array<{ path: Array<string | number>; code: string; message: string }> }
  ).issues;
  if (!Array.isArray(zodIssues)) return [];
  return zodIssues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Validates and RETURNS the parsed value, so a route uses the typed result
 * rather than the raw body. Returning the parse is what makes the schema load
 * bearing: a route that ignored it would still be reading `request.body`, and
 * the schema would drift into decoration.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationError(issuesFrom(result.error));
}

/**
 * Express middleware form. Replaces `request.body` with the PARSED value —
 * coercions and defaults included — so the route downstream cannot accidentally
 * read the unvalidated original.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (request: Request, _response: Response, next: NextFunction) => {
    try {
      request.body = parseOrThrow(schema, request.body ?? {});
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateQuery<T>(schema: ZodType<T>) {
  return (request: Request, _response: Response, next: NextFunction) => {
    try {
      // Express 5 makes `req.query` a getter, so it is stashed rather than
      // reassigned. Routes read it through `validatedQuery(request)`.
      (request as Request & { validatedQuery?: unknown }).validatedQuery = parseOrThrow(
        schema,
        request.query ?? {}
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Reads what `validateQuery` parsed. Throws if the route forgot the middleware. */
export function validatedQuery<T>(request: Request): T {
  const parsed = (request as Request & { validatedQuery?: unknown }).validatedQuery;
  if (parsed === undefined) {
    // A programming error, not a user one: surfacing it as 500 is correct, and
    // saying so plainly beats a mysterious undefined two frames later.
    throw new Error("validatedQuery() called on a route with no validateQuery() middleware.");
  }
  return parsed as T;
}
