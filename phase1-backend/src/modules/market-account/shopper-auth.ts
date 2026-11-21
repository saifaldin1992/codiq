/**
 * Who is shopping: the shopper's session cookie (or a Bearer token from an
 * app), verified exactly like every other identity's — signed, stored, not
 * revoked, not expired, and of the right KIND, so a merchant or a store
 * customer token is refused at the door.
 */
import type { Request, Response } from "express";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { SHOPPER_SESSION_LIFETIME_SECONDS, verifyTypedSession } from "../../auth/identity.js";
import { cookieValue } from "../../http/session-cookie.js";
import { touchSession } from "../../services/session.service.js";
import { config } from "../../config.js";

/** `__Host-` wherever cookies are Secure: bound to this exact host and path, never set by a subdomain. */
export const SHOPPER_COOKIE = config.cookieSecure
  ? "__Host-codiq_shopper_session"
  : "codiq_shopper_session";

export function shopperToken(request: Request): string | null {
  const header = request.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const cookie = cookieValue(request, SHOPPER_COOKIE);
  return cookie ? decodeURIComponent(cookie) : null;
}

export async function requireShopper(request: Request) {
  const token = shopperToken(request);
  if (!token)
    throw new HttpError(401, "SHOPPER_SESSION_REQUIRED", "سجّل الدخول برقم هاتفك للمتابعة.");
  const claims = await verifyTypedSession(token, "shopper");
  const shopper = await prisma.shopper.findUnique({ where: { id: claims.subjectId } });
  if (!shopper?.isActive)
    throw new HttpError(401, "SHOPPER_SESSION_REQUIRED", "سجّل الدخول برقم هاتفك للمتابعة.");
  touchSession(claims, request);
  return { shopper, claims };
}

export function setShopperCookie(response: Response, token: string) {
  response.cookie(SHOPPER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: SHOPPER_SESSION_LIFETIME_SECONDS * 1000,
  });
}

export function clearShopperCookie(response: Response) {
  response.clearCookie(SHOPPER_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
  });
}

/** The signed-in shopper when there is one; `null` for a visitor or a stale session. Never throws for that. */
export async function optionalShopper(request: Request) {
  if (!shopperToken(request)) return null;
  try {
    return (await requireShopper(request)).shopper;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}
