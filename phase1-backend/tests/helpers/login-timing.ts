/**
 * 19-د (ATTACK-SURFACE) — the shared account-enumeration probe for the five
 * sign-in doors.
 *
 * WHAT IT PROVES. Four of the five doors used to be written as
 * `if (!row || … || !(await verifyPassword(…)))`, and `||` short-circuits: an
 * unknown identity returned without ever running bcrypt. At cost 12 that is not
 * a microsecond edge needing statistics (the library at the time was the pure-JS
 * `bcryptjs`; D-36 later moved the same cost onto the threadpool, which changes
 * nothing about the gap) — it measured 942 ms against 16 ms on the platform-owner door and
 * 788 ms against 32 ms on the staff door. ONE request told a stranger whether an
 * address, or an Iraqi mobile number, belonged to a live account.
 *
 * WHY THE MINIMUM, NOT THE MEAN. A timing test that averages is a timing test
 * that flakes: a GC pause or a scheduler hiccup lands in the mean, and the band
 * then has to be widened until it stops catching anything. The MINIMUM over a
 * handful of samples is the stable statistic here — and it is precisely the
 * number an attacker uses, since he keeps the fastest answer and discards the
 * noisy ones.
 *
 * WHY A RATIO AND NOT A FLOOR IN MILLISECONDS. bcrypt cost-12 takes ~500 ms on a
 * developer laptop and something quite different on CI hardware, so an absolute
 * floor would need re-tuning per machine — and a number nobody trusts gets
 * raised until it passes. The two branches are compared against EACH OTHER
 * instead, which is machine-independent: whatever bcrypt costs here, both
 * branches must pay it.
 *
 * The band is deliberately loose. The defect is a 25×–59× gap; anything tighter
 * buys flakiness and catches nothing extra.
 */
import assert from "node:assert/strict";

/** How much faster the unknown-identity branch may answer before it is an oracle. */
export const ENUMERATION_RATIO_FLOOR = 0.5;

/** Samples per branch. Small on purpose — each one costs a real bcrypt compare. */
const SAMPLES = 4;

export interface LoginDoorProbes {
  /** One sign-in attempt against a REAL identity with a WRONG password. */
  known: () => Promise<unknown>;
  /** One sign-in attempt against an identity that does not exist. Same wrong password. */
  unknown: () => Promise<unknown>;
  samples?: number;
}

export interface DoorTiming {
  knownMs: number;
  unknownMs: number;
  ratio: number;
}

export async function measureLoginDoor({ known, unknown, samples = SAMPLES }: LoginDoorProbes): Promise<DoorTiming> {
  // One untimed pass of each first: the very first bcrypt call in a process
  // carries JIT warm-up that belongs to neither branch.
  await known();
  await unknown();

  const timings: { known: number[]; unknown: number[] } = { known: [], unknown: [] };
  // Interleaved, not one branch then the other: a machine that slows down
  // halfway through would otherwise attribute the slowdown to a single branch.
  for (let index = 0; index < samples; index += 1) {
    for (const branch of ["known", "unknown"] as const) {
      const started = process.hrtime.bigint();
      await (branch === "known" ? known() : unknown());
      timings[branch].push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }
  const knownMs = Math.min(...timings.known);
  const unknownMs = Math.min(...timings.unknown);
  return { knownMs, unknownMs, ratio: unknownMs / knownMs };
}

/**
 * Asserts the door does not answer «no such account» measurably faster than
 * «wrong password». Returns the rounded measurement so the suite can report it.
 */
export async function assertNoEnumerationOracle(doorName: string, probes: LoginDoorProbes): Promise<DoorTiming> {
  const measured = await measureLoginDoor(probes);
  assert.ok(
    measured.ratio >= ENUMERATION_RATIO_FLOOR,
    `${doorName}: an unknown identity answered in ${measured.unknownMs.toFixed(0)} ms against ${measured.knownMs.toFixed(0)} ms for a wrong password `
      + `(${measured.ratio.toFixed(2)}×; the floor is ${ENUMERATION_RATIO_FLOOR}×). The door skips bcrypt when nobody matched, so its response `
      + "time enumerates accounts. Run the compare unconditionally against ABSENT_IDENTITY_HASH BEFORE the branch — see auth/identity.ts.",
  );
  return { knownMs: Math.round(measured.knownMs), unknownMs: Math.round(measured.unknownMs), ratio: Number(measured.ratio.toFixed(2)) };
}
