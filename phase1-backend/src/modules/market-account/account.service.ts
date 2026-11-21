/**
 * The market shopper's account: sign-in by phone, the profile, the picture and
 * the delivery addresses. Every read and write is scoped to the signed-in
 * shopper — an address id of someone else answers 404, the same as no address.
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { createTypedSession, normalizeIraqiMobile } from "../../auth/identity.js";
import { governorateLabel, toGovernorateKey } from "../../services/governorates.js";
import {
  deleteMarketImageObjects,
  getStoreLogoBytes,
  putMarketImage,
} from "../../services/product-image-storage.service.js";
import { marketCategoryExists } from "../market-catalog/categories.service.js";
import { listedStoreTenant } from "../market-stores/directory.service.js";
import { consumeOtp, issueOtp } from "./otp.service.js";
import type { AddressInput, ProfileInput } from "./schema.js";

export const MAX_ADDRESSES = 20;

function phoneOrThrow(raw: string): string {
  try {
    return normalizeIraqiMobile(raw);
  } catch {
    throw new HttpError(
      422,
      "INVALID_PHONE",
      "رقم الهاتف غير صحيح — أدخل رقماً عراقياً مثل 07701234567."
    );
  }
}

type ShopperRow = {
  id: string;
  phoneNormalized: string;
  fullName: string | null;
  email: string | null;
  gender: string | null;
  interests: number[];
  avatarObjectKey: string | null;
  createdAt: Date;
};

export function shopperView(row: ShopperRow) {
  return {
    id: row.id,
    // A short id the shopper can read out to support. Not a secret, not a key.
    publicId: row.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
    phone: row.phoneNormalized,
    fullName: row.fullName,
    email: row.email,
    gender: row.gender,
    interests: row.interests,
    avatarUrl: row.avatarObjectKey
      ? `/api/market/me/avatar?v=${encodeURIComponent(row.avatarObjectKey.split("/").pop()?.split(".")[0] ?? "0")}`
      : null,
    memberSince: row.createdAt,
  };
}

// ── sign-in ──────────────────────────────────────────────────────────────────

export async function requestLoginCode(rawPhone: string, ip: string) {
  const phone = phoneOrThrow(rawPhone);
  // Same answer whether or not an account exists: the code creates one on first use.
  return issueOtp({ phone, purpose: "login", shopperId: null, ip });
}

export async function verifyLoginCode(challengeId: string, code: string) {
  const phone = await consumeOtp({ challengeId, code, purpose: "login", shopperId: null });
  const existing = await prisma.shopper.findUnique({ where: { phoneNormalized: phone } });
  if (existing && !existing.isActive)
    throw new HttpError(403, "SHOPPER_DISABLED", "هذا الحساب موقوف. تواصل مع الدعم.");
  const shopper = existing
    ? await prisma.shopper.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } })
    : await prisma.shopper.upsert({
        where: { phoneNormalized: phone },
        update: { lastLoginAt: new Date() },
        create: { phoneNormalized: phone, lastLoginAt: new Date() },
      });
  const token = await createTypedSession("shopper", shopper.id);
  return { token, shopper: shopperView(shopper), isNew: !existing };
}

// ── profile ──────────────────────────────────────────────────────────────────

export async function updateProfile(shopperId: string, input: ProfileInput) {
  for (const id of input.interests) {
    if (!(await marketCategoryExists(id)))
      throw new HttpError(422, "UNKNOWN_MARKET_CATEGORY", "فئة اهتمام غير موجودة.");
  }
  const row = await prisma.shopper.update({
    where: { id: shopperId },
    data: {
      fullName: input.fullName,
      email: input.email?.toLowerCase() ?? null,
      gender: input.gender,
      interests: input.interests,
    },
  });
  return { shopper: shopperView(row) };
}

export async function setAvatar(shopperId: string, file: Express.Multer.File | undefined) {
  if (!file) throw new HttpError(422, "INVALID_AVATAR_IMAGE", "اختر صورة PNG أو JPEG أو WebP.");
  const current = await prisma.shopper.findUniqueOrThrow({
    where: { id: shopperId },
    select: { avatarObjectKey: true },
  });
  const stored = await putMarketImage("avatars", file);
  let row;
  try {
    row = await prisma.shopper.update({
      where: { id: shopperId },
      data: {
        avatarObjectKey: stored.objectKey,
        avatarContentType: stored.contentType,
        avatarByteSize: stored.byteSize,
      },
    });
  } catch (error) {
    await deleteMarketImageObjects([stored.objectKey]);
    throw error;
  }
  if (current.avatarObjectKey) await deleteMarketImageObjects([current.avatarObjectKey]);
  return { shopper: shopperView(row) };
}

export async function removeAvatar(shopperId: string) {
  const current = await prisma.shopper.findUniqueOrThrow({
    where: { id: shopperId },
    select: { avatarObjectKey: true },
  });
  if (!current.avatarObjectKey)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا توجد صورة لحذفها.");
  const row = await prisma.shopper.update({
    where: { id: shopperId },
    data: { avatarObjectKey: null, avatarContentType: null, avatarByteSize: null },
  });
  await deleteMarketImageObjects([current.avatarObjectKey]);
  return { shopper: shopperView(row) };
}

export async function avatarBytes(shopperId: string) {
  const row = await prisma.shopper.findUniqueOrThrow({
    where: { id: shopperId },
    select: { avatarObjectKey: true, avatarContentType: true },
  });
  if (!row.avatarObjectKey || !row.avatarContentType)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا توجد صورة.");
  return {
    contentType: row.avatarContentType,
    bytes: await getStoreLogoBytes(row.avatarObjectKey),
  };
}

// ── addresses ────────────────────────────────────────────────────────────────

const ADDRESS_SELECT = {
  id: true,
  label: true,
  recipientName: true,
  phoneNormalized: true,
  altPhoneNormalized: true,
  governorateKey: true,
  districtId: true,
  district: { select: { nameAr: true } },
  addressLine: true,
  latitude: true,
  longitude: true,
  isDefault: true,
  createdAt: true,
} as const;

type AddressRow = {
  id: string;
  label: string;
  recipientName: string;
  phoneNormalized: string;
  altPhoneNormalized: string | null;
  governorateKey: string;
  districtId: number;
  district: { nameAr: string };
  addressLine: string;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  createdAt: Date;
};

function addressView(row: AddressRow) {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    phone: row.phoneNormalized,
    altPhone: row.altPhoneNormalized,
    governorate: { key: row.governorateKey, name: governorateLabel(row.governorateKey) },
    district: { id: row.districtId, name: row.district.nameAr },
    addressLine: row.addressLine,
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude }
        : null,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
}

/** Bounded: at most MAX_ADDRESSES per shopper. The default first. */
export async function listAddresses(shopperId: string) {
  const rows = await prisma.shopperAddress.findMany({
    where: { shopperId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    take: MAX_ADDRESSES,
    select: ADDRESS_SELECT,
  });
  return { addresses: rows.map(addressView) };
}

export async function requestAddressPhoneCode(shopperId: string, rawPhone: string, ip: string) {
  const phone = phoneOrThrow(rawPhone);
  return issueOtp({ phone, purpose: "address_phone", shopperId, ip });
}

/** The address's phone is proven: the shopper's own number, or a code sent to it and read back. */
async function proveAddressPhone(
  shopper: { id: string; phoneNormalized: string },
  phone: string,
  verification: AddressInput["phoneVerification"]
) {
  if (phone === shopper.phoneNormalized) return;
  if (!verification)
    throw new HttpError(
      422,
      "ADDRESS_PHONE_UNVERIFIED",
      "أكّد رقم الهاتف برمز التحقق المرسل إليه."
    );
  const proven = await consumeOtp({
    challengeId: verification.challengeId,
    code: verification.code,
    purpose: "address_phone",
    shopperId: shopper.id,
  });
  if (proven !== phone)
    throw new HttpError(422, "ADDRESS_PHONE_UNVERIFIED", "الرمز أُرسل إلى رقم آخر.");
}

async function addressData(input: AddressInput) {
  const governorateKey = toGovernorateKey(input.governorateKey);
  if (!governorateKey) throw new HttpError(422, "UNKNOWN_GOVERNORATE", "المحافظة غير معروفة.");
  const district = await prisma.district.findFirst({
    where: { id: input.districtId, governorateKey, isActive: true },
    select: { id: true },
  });
  if (!district)
    throw new HttpError(
      422,
      "DISTRICT_NOT_IN_GOVERNORATE",
      "المنطقة المختارة ليست ضمن هذه المحافظة."
    );
  const phone = phoneOrThrow(input.phone);
  const altPhone = input.altPhone ? phoneOrThrow(input.altPhone) : null;
  if (altPhone === phone)
    throw new HttpError(
      422,
      "ALT_PHONE_SAME",
      "الرقم البديل هو نفس رقم الهاتف — أدخل رقماً آخر أو اتركه فارغاً."
    );
  return {
    label: input.label,
    recipientName: input.recipientName,
    phoneNormalized: phone,
    altPhoneNormalized: altPhone,
    governorateKey,
    districtId: input.districtId,
    addressLine: input.addressLine,
    latitude: input.latitude,
    longitude: input.longitude,
  };
}

export async function createAddress(
  shopper: { id: string; phoneNormalized: string },
  input: AddressInput
) {
  const count = await prisma.shopperAddress.count({ where: { shopperId: shopper.id } });
  if (count >= MAX_ADDRESSES)
    throw new HttpError(422, "TOO_MANY_ADDRESSES", `لا يمكن حفظ أكثر من ${MAX_ADDRESSES} عنواناً.`);
  const data = await addressData(input);
  await proveAddressPhone(shopper, data.phoneNormalized, input.phoneVerification);
  const makeDefault = count === 0 || input.isDefault === true;
  const row = await prisma.$transaction(async (tx) => {
    if (makeDefault)
      await tx.shopperAddress.updateMany({
        where: { shopperId: shopper.id, isDefault: true },
        data: { isDefault: false },
      });
    return tx.shopperAddress.create({
      data: { ...data, shopperId: shopper.id, phoneVerifiedAt: new Date(), isDefault: makeDefault },
      select: ADDRESS_SELECT,
    });
  });
  return { address: addressView(row) };
}

export async function updateAddress(
  shopper: { id: string; phoneNormalized: string },
  addressId: string,
  input: AddressInput
) {
  const current = await prisma.shopperAddress.findFirst({
    where: { id: addressId, shopperId: shopper.id },
    select: { phoneNormalized: true, phoneVerifiedAt: true },
  });
  if (!current) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
  const data = await addressData(input);
  // A changed phone is proven again; an unchanged one keeps its proof.
  const changedPhone = data.phoneNormalized !== current.phoneNormalized;
  if (changedPhone) await proveAddressPhone(shopper, data.phoneNormalized, input.phoneVerification);
  const row = await prisma.$transaction(async (tx) => {
    if (input.isDefault === true)
      await tx.shopperAddress.updateMany({
        where: { shopperId: shopper.id, isDefault: true, id: { not: addressId } },
        data: { isDefault: false },
      });
    return tx.shopperAddress.update({
      where: { id: addressId },
      data: {
        ...data,
        ...(changedPhone ? { phoneVerifiedAt: new Date() } : {}),
        ...(input.isDefault === true ? { isDefault: true } : {}),
      },
      select: ADDRESS_SELECT,
    });
  });
  return { address: addressView(row) };
}

export async function deleteAddress(shopperId: string, addressId: string) {
  const current = await prisma.shopperAddress.findFirst({
    where: { id: addressId, shopperId },
    select: { isDefault: true },
  });
  if (!current) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
  await prisma.$transaction(async (tx) => {
    await tx.shopperAddress.delete({ where: { id: addressId } });
    // The default leaves: the oldest remaining address takes its place, so there is always one when there are any.
    if (current.isDefault) {
      const next = await tx.shopperAddress.findFirst({
        where: { shopperId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (next)
        await tx.shopperAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
  return listAddresses(shopperId);
}

export async function setDefaultAddress(shopperId: string, addressId: string) {
  const current = await prisma.shopperAddress.findFirst({
    where: { id: addressId, shopperId },
    select: { id: true },
  });
  if (!current) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
  await prisma.$transaction([
    prisma.shopperAddress.updateMany({
      where: { shopperId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.shopperAddress.update({ where: { id: addressId }, data: { isDefault: true } }),
  ]);
  return listAddresses(shopperId);
}

/** What delivering this address from this store costs — or that the store does not deliver there. */
export async function deliveryQuote(shopperId: string, addressId: string, storeSlug: string) {
  const address = await prisma.shopperAddress.findFirst({
    where: { id: addressId, shopperId },
    select: { governorateKey: true },
  });
  if (!address) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
  const store = await listedStoreTenant(storeSlug);
  const rate = await prisma.deliveryRate.findUnique({
    where: { storeId_governorate: { storeId: store.id, governorate: address.governorateKey } },
    select: { amountIqd: true, isEnabled: true },
  });
  return {
    storeSlug: store.slug,
    governorate: { key: address.governorateKey, name: governorateLabel(address.governorateKey) },
    available: Boolean(rate?.isEnabled),
    amountIqd: rate?.isEnabled ? rate.amountIqd : null,
  };
}
