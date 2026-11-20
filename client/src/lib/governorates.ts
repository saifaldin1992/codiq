/**
 * ق-162 — the eighteen governorates, mirroring `phase1-backend/src/services/governorates.ts`.
 *
 * WHY A MIRROR AND NOT AN IMPORT. The client bundle does not reach into the
 * server tree — `client/tsconfig` does not include it, and pulling a server
 * module in would drag `prisma` and `config` behind it into the browser. So the
 * list is repeated, exactly as `till-queue.ts` repeats the till's arithmetic and
 * `password-strength.ts` repeats the password rule.
 *
 * AND A REPEATED LIST IS EXACTLY WHAT CAUSED THE DEFECT THIS FIXES. The merchant
 * screen used to hold a private label map that nothing compared against the
 * server's seed, and the two drifted into a state where a shopper was asked, in
 * Arabic, for a value stored only in English — so no real customer could place
 * an order on any store.
 *
 * The difference now is that the copy is GUARDED: `pnpm governorates:test`
 * compares this file to the server's list key by key and name by name, and the
 * build fails if one gains, loses or renames an entry. A mirror nobody checks
 * is a second source of truth; a mirror a test compares is one.
 */
export interface Governorate {
  /** The stored value — never translated, never renamed. Rows depend on it. */
  key: string;
  /** What an Iraqi reads. The only form that should reach a shopper. */
  ar: string;
}

export const GOVERNORATES: readonly Governorate[] = [
  { key: "Baghdad", ar: "بغداد" },
  { key: "Basra", ar: "البصرة" },
  { key: "Erbil", ar: "أربيل" },
  { key: "Al Anbar", ar: "الأنبار" },
  { key: "Babylon", ar: "بابل" },
  { key: "Dhi Qar", ar: "ذي قار" },
  { key: "Diyala", ar: "ديالى" },
  { key: "Dohuk", ar: "دهوك" },
  { key: "Karbala", ar: "كربلاء" },
  { key: "Kirkuk", ar: "كركوك" },
  { key: "Maysan", ar: "ميسان" },
  { key: "Muthanna", ar: "المثنى" },
  { key: "Najaf", ar: "النجف" },
  { key: "Nineveh", ar: "نينوى" },
  { key: "Al-Qadisiyyah", ar: "القادسية" },
  { key: "Saladin", ar: "صلاح الدين" },
  { key: "Sulaymaniyah", ar: "السليمانية" },
  { key: "Wasit", ar: "واسط" },
];

const BY_KEY = new Map(GOVERNORATES.map((governorate) => [governorate.key, governorate]));

/** The Arabic name for a stored key, or the key itself when it is not one of ours. */
export function governorateLabel(key: string): string {
  return BY_KEY.get(key)?.ar ?? key;
}
