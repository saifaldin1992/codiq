/**
 * Marketplace M9 — the prize wheel.
 *
 * THE DRAW IS THE SERVER'S. The browser gets the segments' labels and nothing
 * else — no weights, no stock — and is told which segment to stop on AFTER the
 * draw. The draw:
 *   1. locks the shopper's row, so his spins are counted one at a time;
 *   2. picks a prize by weight among those with stock left (crypto.randomInt);
 *   3. takes ONE unit with `UPDATE … WHERE won_count < stock` — if another spin
 *      took the last one first, that update touches nothing and the draw picks
 *      again among the rest. The CHECK `won_count <= stock` is the last word.
 * A shopper who has won the most the wheel allows only lands on «حظّ أوفر».
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import {
  decodeListCursor,
  encodeListCursor,
  pageOf,
  parseListLimit,
} from "../../services/list-page.js";
import { issueCoupon } from "../market-rewards/rewards.service.js";

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

async function openWheel(now: Date) {
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

// ── «الجوائز مالتك» ────────────────────────────────────────────────────────

const WIN_LABEL: Record<string, string> = {
  pending: "بانتظار استلامك",
  claimed: "استلمتها",
  shipping: "بالطريق إلك",
  delivered: "وصلتك",
  cancelled: "انلغت",
  expired: "خلص وقت استلامها",
};

function winView(
  row: {
    id: string;
    status: string;
    claimBy: Date;
    claimedAt: Date | null;
    walletId: string | null;
    createdAt: Date;
    prize: {
      label: string;
      kind: string;
      points: number | null;
      coupon: { code: string; title: string } | null;
    };
  },
  now: Date
) {
  const status = row.status === "pending" && now > row.claimBy ? "expired" : row.status;
  return {
    id: row.id,
    status,
    statusLabel: WIN_LABEL[status] ?? status,
    claimBy: row.claimBy,
    claimedAt: row.claimedAt,
    wonAt: row.createdAt,
    prize: {
      label: row.prize.label,
      kind: row.prize.kind,
      points: row.prize.points,
      couponTitle: row.prize.coupon?.title ?? null,
    },
    // The «كود جاهز»: once claimed, a coupon is in his wallet under this code.
    code: status !== "pending" && row.prize.coupon ? row.prize.coupon.code : null,
  };
}
const WIN_SELECT = {
  id: true,
  status: true,
  claimBy: true,
  claimedAt: true,
  walletId: true,
  createdAt: true,
  prize: {
    select: {
      label: true,
      kind: true,
      points: true,
      coupon: { select: { code: true, title: true } },
    },
  },
} as const;

export async function myWins(
  shopperId: string,
  rawCursor: unknown,
  rawLimit: unknown,
  now = new Date()
) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor("market-wheel-wins", rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.wheelWin.findMany({
    where: {
      shopperId,
      ...(cursor && at
        ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: WIN_SELECT,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor("market-wheel-wins", last.createdAt, last.id)
  );
  return { wins: page.map((row) => winView(row, now)), nextCursor };
}

export async function claimWin(
  shopperId: string,
  winId: string,
  input: { addressId?: string },
  now = new Date()
) {
  if (!/^[0-9a-f-]{36}$/i.test(winId))
    throw new HttpError(404, "WIN_NOT_FOUND", "الجائزة غير موجودة.");
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM wheel_wins WHERE id = ${winId}::uuid AND shopper_id = ${shopperId}::uuid FOR UPDATE`;
    if (!locked) throw new HttpError(404, "WIN_NOT_FOUND", "الجائزة غير موجودة.");
    const win = await tx.wheelWin.findUniqueOrThrow({
      where: { id: winId },
      include: { prize: true },
    });
    if (win.status !== "pending")
      throw new HttpError(409, "WIN_ALREADY_CLAIMED", "استلمت هذه الجائزة مسبقاً.");
    if (now > win.claimBy) throw new HttpError(409, "WIN_EXPIRED", "خلص وقت استلام هذه الجائزة.");
    const data: Prisma.WheelWinUpdateInput = { claimedAt: now, status: "claimed" };
    if (win.prize.kind === "coupon" && win.prize.couponId) {
      await issueCoupon(tx, win.prize.couponId, now);
      const held = await tx.shopperCoupon.create({
        data: { shopperId, couponId: win.prize.couponId, source: "granted" },
        select: { id: true },
      });
      data.walletId = held.id;
    } else if (win.prize.kind === "points" && win.prize.points) {
      await tx.shopperPointsEntry.create({
        data: { shopperId, delta: win.prize.points, reason: "granted" },
      });
    } else if (win.prize.kind === "physical") {
      if (!input.addressId)
        throw new HttpError(422, "ADDRESS_REQUIRED", "اختر العنوان الذي نوصل إليه جائزتك.");
      const address = await tx.shopperAddress.findFirst({
        where: { id: input.addressId, shopperId },
        select: { id: true },
      });
      if (!address) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
      data.addressId = address.id;
      data.status = "shipping";
    }
    const updated = await tx.wheelWin.update({ where: { id: winId }, data, select: WIN_SELECT });
    return { win: winView(updated, now) };
  });
}

// ── the winners board and the log ──────────────────────────────────────────

function maskedName(name: string | null, phone: string) {
  const first = name?.trim().split(/\s+/)[0];
  return `${first || "متسوّق"} ••${phone.slice(-2)}`;
}

/** «ترتيب الفائزين»: the twenty with the most prizes, and where the shopper stands. */
export async function leaderboard(shopperId: string | null, now = new Date()) {
  const wheel =
    (await openWheel(now)) ??
    (await prisma.marketWheel.findFirst({ orderBy: { startsAt: "desc" } }));
  if (!wheel) return { board: [], me: null };
  const rows = await prisma.$queryRaw<
    {
      shopper_id: string;
      wins: number;
      rank: number;
      full_name: string | null;
      phone_normalized: string;
    }[]
  >`
    SELECT w.shopper_id, w.wins, w.rank, s.full_name, s.phone_normalized FROM (
      SELECT shopper_id, count(*)::int AS wins, (rank() OVER (ORDER BY count(*) DESC, min(created_at) ASC))::int AS rank
        FROM wheel_wins WHERE wheel_id = ${wheel.id}::uuid AND status <> 'cancelled' GROUP BY shopper_id
    ) w JOIN shoppers s ON s.id = w.shopper_id
    WHERE w.rank <= 20 OR w.shopper_id = ${shopperId ?? "00000000-0000-0000-0000-000000000000"}::uuid
    ORDER BY w.rank, w.shopper_id`;
  const mine = rows.find((row) => row.shopper_id === shopperId);
  return {
    board: rows
      .filter((row) => row.rank <= 20)
      .map((row) => ({
        rank: row.rank,
        name: maskedName(row.full_name, row.phone_normalized),
        wins: row.wins,
        isMe: row.shopper_id === shopperId,
      })),
    me: shopperId ? (mine ? { rank: mine.rank, wins: mine.wins } : { rank: null, wins: 0 }) : null,
  };
}

export async function spinLog(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor("market-wheel-spins", rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.wheelSpin.findMany({
    where: {
      shopperId,
      ...(cursor && at
        ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      kind: true,
      prizeLabel: true,
      createdAt: true,
      win: { select: { id: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor("market-wheel-spins", last.createdAt, last.id)
  );
  return {
    spins: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      prizeLabel: row.prizeLabel,
      won: Boolean(row.win),
      at: row.createdAt,
    })),
    nextCursor,
  };
}

// ── the owner ──────────────────────────────────────────────────────────────

type WheelInput = {
  slug: string;
  title: string;
  howToPlay?: string | null;
  isOpen: boolean;
  startsAt: Date;
  endsAt: Date;
  dailyFreeSpins: number;
  iqdPerExtraSpin: number;
  maxExtraSpinsPerOrder: number;
  maxWinsPerShopper: number;
  claimDays: number;
};
type PrizeInput = {
  label: string;
  kind: "nothing" | "points" | "coupon" | "physical";
  weight: number;
  stock?: number | null;
  points?: number | null;
  couponId?: string | null;
  position: number;
  isActive: boolean;
};

export async function ownerWheels() {
  const wheels = await prisma.marketWheel.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    include: { prizes: { orderBy: [{ position: "asc" }, { id: "asc" }], take: 40 } },
  });
  return { wheels };
}

export async function saveWheel(id: string | null, input: WheelInput) {
  const clash = await prisma.marketWheel.findFirst({
    where: { slug: input.slug, ...(id ? { id: { not: id } } : {}) },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, "WHEEL_SLUG_TAKEN", "يوجد عجلة بهذا المعرّف.");
  const wheel = id
    ? await prisma.marketWheel.update({ where: { id }, data: input })
    : await prisma.marketWheel.create({ data: input });
  return { wheel };
}

function prizeData(input: PrizeInput) {
  return {
    label: input.label,
    kind: input.kind,
    weight: input.weight,
    position: input.position,
    isActive: input.isActive,
    stock: input.kind === "nothing" ? null : (input.stock ?? null),
    points: input.kind === "points" ? (input.points ?? null) : null,
    couponId: input.kind === "coupon" ? (input.couponId ?? null) : null,
  };
}

export async function addPrize(wheelId: string, input: PrizeInput) {
  if (!(await prisma.marketWheel.findUnique({ where: { id: wheelId }, select: { id: true } })))
    throw new HttpError(404, "WHEEL_NOT_FOUND", "العجلة غير موجودة.");
  return { prize: await prisma.wheelPrize.create({ data: { wheelId, ...prizeData(input) } }) };
}

/** A prize already won keeps what it is: only its label, weight, stock (never below what was won), place and switch change. */
export async function updatePrize(prizeId: string, input: PrizeInput) {
  const prize = await prisma.wheelPrize.findUnique({ where: { id: prizeId } });
  if (!prize) throw new HttpError(404, "PRIZE_NOT_FOUND", "الجائزة غير موجودة.");
  const data = prizeData(input);
  if (
    prize.wonCount > 0 &&
    (data.kind !== prize.kind || data.points !== prize.points || data.couponId !== prize.couponId)
  ) {
    throw new HttpError(
      409,
      "PRIZE_ALREADY_WON",
      "رُبحت هذه الجائزة؛ لا يتغيّر نوعها ولا قيمتها. أضف جائزة جديدة."
    );
  }
  if (data.stock !== null && data.stock < prize.wonCount)
    throw new HttpError(422, "PRIZE_STOCK_BELOW_WON", `رُبح منها ${prize.wonCount} بالفعل.`);
  return { prize: await prisma.wheelPrize.update({ where: { id: prizeId }, data }) };
}

const QUEUE_KIND = "market-wheel-queue";
/** Physical prizes to send, and every win for support. */
export async function winsQueue(
  wheelId: string,
  status: string | undefined,
  rawCursor: unknown,
  rawLimit: unknown,
  now = new Date()
) {
  const limit = parseListLimit(rawLimit, 100, 50);
  const cursor = decodeListCursor(`${QUEUE_KIND}.${status ?? "all"}`, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.wheelWin.findMany({
    where: {
      wheelId,
      ...(status ? { status } : {}),
      ...(cursor && at
        ? { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      ...WIN_SELECT,
      addressId: true,
      note: true,
      shopper: { select: { fullName: true, phoneNormalized: true } },
    },
  });
  const addresses = await prisma.shopperAddress.findMany({
    where: {
      id: { in: rows.map((row) => row.addressId).filter((id): id is string => Boolean(id)) },
    },
    select: {
      id: true,
      recipientName: true,
      phoneNormalized: true,
      addressLine: true,
      district: { select: { nameAr: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(`${QUEUE_KIND}.${status ?? "all"}`, last.createdAt, last.id)
  );
  return {
    wins: page.map((row) => ({
      ...winView(row, now),
      shopper: { name: row.shopper.fullName, phone: row.shopper.phoneNormalized },
      note: row.note,
      address: addresses.find((address) => address.id === row.addressId) ?? null,
    })),
    nextCursor,
  };
}

export async function setWinStatus(
  winId: string,
  input: { status: "delivered" | "cancelled"; note?: string }
) {
  const win = await prisma.wheelWin.findUnique({
    where: { id: winId },
    include: { prize: { select: { id: true, kind: true } } },
  });
  if (!win) throw new HttpError(404, "WIN_NOT_FOUND", "الجائزة غير موجودة.");
  if (input.status === "delivered" && win.status !== "shipping")
    throw new HttpError(409, "WIN_NOT_SHIPPING", "الجائزة ليست في الطريق.");
  if (input.status === "cancelled" && !["pending", "shipping"].includes(win.status))
    throw new HttpError(409, "WIN_NOT_CANCELLABLE", "لا تُلغى جائزة استُلمت.");
  if (input.status === "cancelled" && !input.note?.trim())
    throw new HttpError(422, "WIN_CANCEL_NOTE_REQUIRED", "اكتب سبب الإلغاء — يراه المتسوّق.");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.wheelWin.update({
      where: { id: winId },
      data: { status: input.status, note: input.note?.trim() || null },
      select: { id: true, status: true },
    });
    // A cancelled prize goes back into the wheel's stock.
    if (input.status === "cancelled")
      await tx.$executeRaw`UPDATE wheel_prizes SET won_count = won_count - 1 WHERE id = ${win.prize.id}::uuid AND won_count > 0`;
    return { win: updated };
  });
}

/** The owner's per-prize tally — the only place weights and stock are shown. */
export async function wheelReport(wheelId: string) {
  const [prizes, spins, wins] = await Promise.all([
    prisma.wheelPrize.findMany({
      where: { wheelId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: 40,
      select: {
        id: true,
        label: true,
        kind: true,
        weight: true,
        stock: true,
        wonCount: true,
        isActive: true,
        position: true,
        points: true,
        couponId: true,
      },
    }),
    prisma.wheelSpin.count({ where: { wheelId } }),
    prisma.wheelWin.groupBy({ by: ["status"], where: { wheelId }, _count: { _all: true } }),
  ]);
  return {
    prizes,
    spins,
    wins: Object.fromEntries(wins.map((row) => [row.status, row._count._all])),
  };
}

/** Support: one shopper's spins on the wheel, by phone. */
export async function supportSpins(phone: string) {
  const shopper = await prisma.shopper.findUnique({
    where: { phoneNormalized: phone },
    select: { id: true, fullName: true },
  });
  if (!shopper) throw new HttpError(404, "SHOPPER_NOT_FOUND", "لا يوجد متسوّق بهذا الرقم.");
  return {
    shopper,
    ...(await spinLog(shopper.id, undefined, 50)),
    ...(await myWins(shopper.id, undefined, 50)),
  };
}
