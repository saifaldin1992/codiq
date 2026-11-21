/**
 * Marketplace M13a — cancel card orders nobody paid for within 30 minutes and
 * return their stock: `pnpm market:payments:expire`, from a scheduler every few
 * minutes. (The same sweep also runs whenever a shopper or the owner opens a payment.)
 */
import { prisma } from "../src/db/prisma.js";
import { expireStalePayments } from "../src/modules/market-payments/payments.service.js";

try {
  console.log(JSON.stringify({ expired: await expireStalePayments() }));
} finally {
  await prisma.$disconnect();
}
