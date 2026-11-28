/**
 * Prize wheel — play. Split verbatim from wheel.service.ts
 * (review batch 6, ت-٢); wheel.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";

const DAY_MS = 86_400_000;

const BAGHDAD_MS = 3 * 3_600_000;

const NOTHING_LABEL = "حظّ أوفر";

/** The Baghdad calendar day (UTC+3, no DST) — when the free spin comes back. */
export function baghdadDay(now: Date) {
  return new Date(now.valueOf() + BAGHDAD_MS).toISOString().slice(0, 10);
}

function nextBaghdadMidnight(now: Date) {
  const day = baghdadDay(now);
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS - BAGHDAD_MS);
}

export async function openWheel(now: Date) {
  return prisma.marketWheel.findFirst({
    where: { isOpen: true, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: "desc" },
  });
}

type Db = Prisma.TransactionClient | typeof prisma;

type Wheel = NonNullable<Awaited<ReturnType<typeof openWheel>>>;

async function spinState(db: Db, wheel: Wheel, shopperId: string, now: Date) {
  const today = new Date(`${baghdadDay(now)}T00:00:00Z`);
  const [freeUsed, bonusUsed, granted, wins] = await Promise.all([
    db.wheelSpin.count({ where: { wheelId: wheel.id, shopperId, kind: "free", day: today } }),
    db.wheelSpin.count({ where: { wheelId: wheel.id, shopperId, kind: "bonus" } }),
    db.wheelSpinGrant.aggregate({ where: { wheelId: wheel.id, shopperId }, _sum: { spins: true } }),
    db.wheelWin.count({ where: { wheelId: wheel.id, shopperId, status: { not: "cancelled" } } }),
  ]);
  const freeLeft = Math.max(0, wheel.dailyFreeSpins - freeUsed);
  const bonusLeft = Math.max(0, (granted._sum.spins ?? 0) - bonusUsed);
  return {
    freeLeft,
    bonusLeft,
    spinsLeft: freeLeft + bonusLeft,
    nextFreeAt: freeLeft ? null : nextBaghdadMidnight(now),
    wins,
    maxWins: wheel.maxWinsPerShopper,
    reachedMaxWins: wins >= wheel.maxWinsPerShopper,
  };
}

/** What the browser may know: labels and kinds, in wheel order. */
async function segments(wheelId: string) {
  return prisma.wheelPrize.findMany({
    where: { wheelId, isActive: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, label: true, kind: true },
  });
}

export async function wheelPage(shopperId: string | null, now = new Date()) {
  const wheel = await openWheel(now);
  if (!wheel) {
    const next = await prisma.marketWheel.findFirst({
      where: { isOpen: true, startsAt: { gt: now } },
      orderBy: { startsAt: "asc" },
      select: { title: true, startsAt: true },
    });
    return {
      open: false,
      reason: "العجلة مسكّرة حالياً.",
      next,
      wheel: null,
      segments: [],
      state: null,
      codesGone: false,
    };
  }
  const [list, stocked] = await Promise.all([
    segments(wheel.id),
    prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM wheel_prizes WHERE wheel_id = ${wheel.id}::uuid AND is_active AND kind <> 'nothing' AND weight > 0 AND (stock IS NULL OR won_count < stock)`,
  ]);
  return {
    open: true,
    reason: null,
    next: null,
    wheel: {
      slug: wheel.slug,
      title: wheel.title,
      howToPlay: wheel.howToPlay,
      endsAt: wheel.endsAt,
      dailyFreeSpins: wheel.dailyFreeSpins,
      iqdPerExtraSpin: wheel.iqdPerExtraSpin,
      claimDays: wheel.claimDays,
    },
    segments: list.map(({ id: _id, ...segment }, index) => ({ index, ...segment })),
    // «الأكواد خلصت»: every prize worth winning is gone; spins only land on «حظّ أوفر».
    codesGone: (stocked[0]?.n ?? 0) === 0,
    state: shopperId ? await spinState(prisma, wheel, shopperId, now) : null,
  };
}

type Candidate = { id: string; label: string; kind: string; weight: number };

function pick(candidates: Candidate[]): Candidate {
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = randomInt(0, total);
  for (const candidate of candidates) {
    if (roll < candidate.weight) return candidate;
    roll -= candidate.weight;
  }
  return candidates[candidates.length - 1];
}

export async function spin(shopperId: string, now = new Date()) {
  const wheel = await openWheel(now);
  if (!wheel) throw new HttpError(409, "WHEEL_CLOSED", "العجلة مسكّرة حالياً.");
  const list = await segments(wheel.id);
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM shoppers WHERE id = ${shopperId}::uuid FOR UPDATE`;
      const state = await spinState(tx, wheel, shopperId, now);
      if (!state.spinsLeft)
        throw new HttpError(
          409,
          "NO_SPINS_LEFT",
          "خلصت لفّاتك. لفّة جديدة غداً، أو اكسب لفّات بالتسوّق.",
          { nextFreeAt: state.nextFreeAt }
        );
      const kind = state.freeLeft ? "free" : "bonus";
      let candidates = (
        await tx.wheelPrize.findMany({
          where: { wheelId: wheel.id, isActive: true, weight: { gt: 0 } },
          select: { id: true, label: true, kind: true, weight: true, stock: true, wonCount: true },
        })
      )
        .filter((prize) => prize.stock === null || prize.wonCount < prize.stock)
        .filter((prize) => !state.reachedMaxWins || prize.kind === "nothing");
      let won: Candidate | null = null;
      while (candidates.length) {
        const chosen = pick(candidates);
        if (chosen.kind === "nothing") {
          won = chosen;
          break;
        }
        const taken =
          await tx.$executeRaw`UPDATE wheel_prizes SET won_count = won_count + 1 WHERE id = ${chosen.id}::uuid AND (stock IS NULL OR won_count < stock)`;
        if (taken === 1) {
          won = chosen;
          break;
        }
        // Someone else took the last one: draw again among the rest.
        candidates = candidates.filter((candidate) => candidate.id !== chosen.id);
      }
      const label = won?.label ?? NOTHING_LABEL;
      const spinRow = await tx.wheelSpin.create({
        data: {
          wheelId: wheel.id,
          shopperId,
          kind,
          day: new Date(`${baghdadDay(now)}T00:00:00Z`),
          prizeId: won?.id ?? null,
          prizeLabel: label,
        },
      });
      const win =
        won && won.kind !== "nothing"
          ? await tx.wheelWin.create({
              data: {
                wheelId: wheel.id,
                spinId: spinRow.id,
                shopperId,
                prizeId: won.id,
                claimBy: new Date(now.valueOf() + wheel.claimDays * DAY_MS),
              },
              select: { id: true, claimBy: true },
            })
          : null;
      return {
        won,
        win,
        state: await spinState(tx, wheel, shopperId, now),
        reachedMaxWins: state.reachedMaxWins,
      };
      // A campaign hour can bring a thousand spins at once: a spin may wait its turn
      // for a connection rather than fail. Each spin's own work is a few short queries.
    },
    { maxWait: 20_000, timeout: 15_000 }
  );
  const index = result.won
    ? list.findIndex((segment) => segment.id === result.won!.id)
    : list.findIndex((segment) => segment.kind === "nothing");
  return {
    segmentIndex: index,
    prize: { label: result.won?.label ?? NOTHING_LABEL, kind: result.won?.kind ?? "nothing" },
    win: result.win,
    message: result.win
      ? "مبروك! استلم جائزتك من «الجوائز مالتك»."
      : result.reachedMaxWins
        ? "ربحت أكثر ما تسمح به العجلة — شكراً لمشاركتك."
        : "حظّ أوفر المرّة الجاية!",
    state: result.state,
  };
}
