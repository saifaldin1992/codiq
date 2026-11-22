/**
 * Storefront — addresses. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { normalizePhone } from "../../auth/identity.js";
import { HttpError } from "../../auth/auth.errors.js";
import { GOVERNORATE_KEYS, governorateLabel, toGovernorateKey } from "../governorates.js";
import { requiredText, type CheckoutInput } from "./shared.js";

export async function listAddresses(storeId: string, customerId: string) {
  return prisma.customerAddress.findMany({
    where: { storeId, customerId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      recipientName: true,
      fullAddress: true,
      city: true,
      governorate: true,
      phoneContactNormalized: true,
      isDefault: true,
      createdAt: true,
    },
  });
}

export async function createAddress(
  storeId: string,
  customerId: string,
  body: Record<string, unknown>
) {
  const recipientName = requiredText(body.recipientName, "recipientName", 240);
  const fullAddress = requiredText(body.fullAddress, "fullAddress", 1000);
  const city = requiredText(body.city, "city", 120);
  const governorate = requiredText(body.governorate, "governorate", 120);
  const phoneContactNormalized = normalizePhone(body.phoneContact);
  const isDefault = body.isDefault === true;
  return prisma.$transaction(async (tx) => {
    if (isDefault)
      await tx.customerAddress.updateMany({
        where: { storeId, customerId, isDefault: true },
        data: { isDefault: false },
      });
    const hasAddress = await tx.customerAddress.count({ where: { storeId, customerId } });
    return tx.customerAddress.create({
      data: {
        storeId,
        customerId,
        recipientName,
        fullAddress,
        city,
        governorate,
        phoneContactNormalized,
        isDefault: isDefault || hasAddress === 0,
      },
    });
  });
}

export async function updateAddress(
  storeId: string,
  customerId: string,
  addressId: string,
  body: Record<string, unknown>
) {
  const existing = await prisma.customerAddress.findFirst({
    where: { id: addressId, storeId, customerId },
  });
  if (!existing)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
  const data: Record<string, unknown> = {};
  if (body.recipientName !== undefined)
    data.recipientName = requiredText(body.recipientName, "recipientName", 240);
  if (body.fullAddress !== undefined)
    data.fullAddress = requiredText(body.fullAddress, "fullAddress", 1000);
  if (body.city !== undefined) data.city = requiredText(body.city, "city", 120);
  if (body.governorate !== undefined)
    data.governorate = requiredText(body.governorate, "governorate", 120);
  if (body.phoneContact !== undefined)
    data.phoneContactNormalized = normalizePhone(body.phoneContact);
  if (body.isDefault === true) {
    return prisma.$transaction(async (tx) => {
      await tx.customerAddress.updateMany({
        where: { storeId, customerId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.customerAddress.update({
        where: { id: existing.id },
        data: { ...data, isDefault: true },
      });
    });
  }
  return prisma.customerAddress.update({ where: { id: existing.id }, data });
}

export async function deleteAddress(storeId: string, customerId: string, addressId: string) {
  const existing = await prisma.customerAddress.findFirst({
    where: { id: addressId, storeId, customerId },
  });
  if (!existing)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
  await prisma.customerAddress.delete({ where: { id: existing.id } });
}

export async function addressForCheckout(
  tx: Prisma.TransactionClient,
  storeId: string,
  customerId: string,
  input: CheckoutInput
) {
  if (typeof input.addressId === "string") {
    const address = await tx.customerAddress.findFirst({
      where: { id: input.addressId, storeId, customerId },
    });
    if (!address)
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
    return address;
  }
  if (!input.address || typeof input.address !== "object")
    throw new HttpError(400, "INVALID_ADDRESS", "A saved address or address payload is required.");
  const address = input.address as Record<string, unknown>;
  return tx.customerAddress.create({
    data: {
      storeId,
      customerId,
      recipientName: requiredText(address.recipientName, "recipientName", 240),
      fullAddress: requiredText(address.fullAddress, "fullAddress", 1000),
      city: requiredText(address.city, "city", 120),
      governorate: requiredText(address.governorate, "governorate", 120),
      phoneContactNormalized: normalizePhone(address.phoneContact),
      isDefault: false,
    },
  });
}

/**
 * ق-162 — the governorates THIS store delivers to, for an anonymous shopper.
 *
 * Public on purpose: a person choosing where to have something delivered has
 * not signed in yet, and asking him to register before he can see whether the
 * shop reaches his city is a door that loses him.
 *
 * It answers only what is ENABLED, which makes a second thing visible that used
 * to be silent: a brand-new store publishes its products the moment they are
 * created but delivers nowhere until the merchant sets his fees. The storefront
 * can now say that out loud instead of accepting a cart and refusing it at the
 * last step.
 */
export async function publicDeliveryAreas(storeId: string) {
  const rates = await prisma.deliveryRate.findMany({
    where: { storeId, isEnabled: true },
    select: { governorate: true, amountIqd: true },
  });
  const order = new Map(GOVERNORATE_KEYS.map((key, index) => [key, index]));
  return rates
    .map((rate) => ({
      key: rate.governorate,
      name: governorateLabel(rate.governorate),
      amountIqd: rate.amountIqd,
    }))
    .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

/**
 * ق-162 — resolves whatever was stored on the address to the KEY the rates use.
 *
 * The shopper now picks from a list, so new addresses already carry the key.
 * But an address saved before that carries whatever he typed — «بغداد», or
 * «بصرة» without its article — and refusing those would break checkout for the
 * very people the fix is for. `toGovernorateKey` maps them; anything it does
 * not recognise is passed through unchanged, so the failure stays «this store
 * does not deliver there» rather than «we could not read your address».
 */
export async function deliveryRateForGovernorate(
  tx: Prisma.TransactionClient,
  storeId: string,
  governorate: string
) {
  const key = toGovernorateKey(governorate) ?? governorate;
  const rate = await tx.deliveryRate.findFirst({
    where: { storeId, governorate: key, isEnabled: true },
    select: { governorate: true, amountIqd: true },
  });
  if (!rate) {
    throw new HttpError(
      422,
      "DELIVERY_UNAVAILABLE_FOR_GOVERNORATE",
      `هذا المتجر لا يوصّل إلى ${governorateLabel(key)} حالياً. اختر محافظة أخرى أو تواصل مع المتجر.`
    );
  }
  return rate;
}

export async function deliveryQuote(storeId: string, customerId: string, addressId: string) {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, storeId, customerId },
    select: { governorate: true },
  });
  if (!address)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
  return deliveryRateForGovernorate(prisma, storeId, address.governorate);
}
