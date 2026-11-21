/**
 * The signed-in market shopper, shared by every screen: read once from
 * /api/market/me, updated in place on sign-in, profile edits and sign-out.
 */
import { useEffect, useState } from "react";

export type Shopper = {
  id: string;
  publicId: string;
  phone: string;
  fullName: string | null;
  email: string | null;
  gender: "male" | "female" | null;
  interests: number[];
  avatarUrl: string | null;
  memberSince: string;
};
type State = { status: "loading" | "signed-out" | "signed-in"; shopper: Shopper | null };

let state: State = { status: "loading", shopper: null };
let requested = false;
const listeners = new Set<(next: State) => void>();

function publish(next: State) {
  state = next;
  listeners.forEach((listener) => listener(state));
}

export function setShopper(shopper: Shopper | null) {
  publish(shopper ? { status: "signed-in", shopper } : { status: "signed-out", shopper: null });
}

async function load() {
  try {
    const response = await fetch("/api/market/me", { credentials: "same-origin" });
    if (!response.ok) {
      setShopper(null);
      return;
    }
    setShopper((await response.json()).shopper ?? null);
  } catch {
    setShopper(null);
  }
}

export function useShopper(): State {
  const [current, setCurrent] = useState<State>(state);
  useEffect(() => {
    listeners.add(setCurrent);
    if (!requested) {
      requested = true;
      void load();
    }
    setCurrent(state);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return current;
}

/** The one write helper for the account screens: JSON, same-origin, the server's Arabic message on failure. */
export async function accountCall<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) setShopper(null);
  if (!response.ok)
    throw Object.assign(new Error(body?.error?.message ?? "تعذّر الاتصال بالخادم، حاول مرة أخرى"), {
      code: body?.error?.code as string | undefined,
      details: body?.error,
    });
  return body as T;
}

export async function signOut() {
  await accountCall("/api/market/auth/logout", { method: "POST" }).catch(() => undefined);
  setShopper(null);
}

/** «0770 123 4567» for an Iraqi E.164 number; anything else unchanged. */
export function displayPhone(e164: string) {
  const match = /^\+964(7\d{2})(\d{3})(\d{4})$/.exec(e164);
  return match ? `0${match[1]} ${match[2]} ${match[3]}` : e164;
}
