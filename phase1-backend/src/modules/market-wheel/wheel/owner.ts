/**
 * Prize wheel — owner. Split verbatim from wheel.service.ts
 * (review batch 6, ت-٢); wheel.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import { WIN_SELECT, winView, spinLog, myWins } from "./wins.js";

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
    // Review batch 6, ت-١: the move is CLAIMED on the status it was read with. Two cancels
    // together, or a cancel racing the shopper's claim (which holds the row FOR UPDATE), used
    // to both pass — the unit came back twice, or a claimed prize was cancelled under him.
    const moved = await tx.wheelWin.updateMany({
      where: { id: winId, status: win.status },
      data: { status: input.status, note: input.note?.trim() || null },
    });
    if (moved.count !== 1)
      throw new HttpError(409, "WIN_STATUS_CHANGED", "تغيّرت حالة الجائزة للتوّ — حدّث الصفحة.");
    const updated = { id: winId, status: input.status };
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
