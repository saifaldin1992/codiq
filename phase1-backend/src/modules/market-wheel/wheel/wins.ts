/**
 * Prize wheel — wins. Split verbatim from wheel.service.ts
 * (review batch 6, ت-٢); wheel.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { issueCoupon } from "../../market-rewards/rewards.service.js";
import { openWheel } from "./play.js";

// ── «الجوائز مالتك» ────────────────────────────────────────────────────────

const WIN_LABEL: Record<string, string> = {
  pending: "بانتظار استلامك",
  claimed: "استلمتها",
  shipping: "بالطريق إلك",
  delivered: "وصلتك",
  cancelled: "انلغت",
  expired: "خلص وقت استلامها",
};

export function winView(
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

export const WIN_SELECT = {
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
