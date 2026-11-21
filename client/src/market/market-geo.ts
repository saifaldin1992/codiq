/** Marketplace M11: where the shopper is — asked only when he presses a button, remembered for the visit. */
export type LatLng = { lat: number; lng: number };
let last: LatLng | null = null;

export type LocateFailure = "denied" | "unavailable";
export function locateShopper(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject("unavailable" satisfies LocateFailure);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (result) => {
        last = { lat: result.coords.latitude, lng: result.coords.longitude };
        resolve(last);
      },
      (error) =>
        reject(
          (error.code === error.PERMISSION_DENIED
            ? "denied"
            : "unavailable") satisfies LocateFailure
        ),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  });
}

/** The position, without a prompt: known this visit, or the browser already allows it. */
export async function quietPosition(): Promise<LatLng | null> {
  if (last) return last;
  try {
    const state = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
    if (state?.state !== "granted") return null;
    return await locateShopper();
  } catch {
    return null;
  }
}

export const LOCATE_TEXT: Record<LocateFailure, string> = {
  denied: "فعّل صلاحيّة الموقع من إعدادات المتصفّح ثم أعد المحاولة.",
  unavailable: "تعذّر تحديد موقعك، حاول مرة أخرى.",
};
