/**
 * Marketplace M13b — the partner app (a wallet).
 *
 * A2 · SIGN-IN FROM THE PARTNER. The partner opens the market with a token it
 * SIGNED (HMAC-SHA256 with the shared secret): its account id, the phone it
 * verified, a nonce, the time. Two minutes to use it, once. The first time the
 * partner account is linked to the market shopper with that phone (created if
 * new — the partner verified the number); afterwards the link alone signs him
 * in, and a token whose phone no longer matches the linked shopper is refused
 * until he signs in with his code again (re-authentication). Each entry is a
 * sync: «آخر مزامنة», and an empty name is taken from the partner.
 *
 * F10 · PAYMENT LINKS. A linked shopper asks for a link to pay one store's
 * part of his cart in the partner app. The link is a random token (only its
 * hash is kept), valid once, for 15 minutes, for that shopper, that cart and
 * that amount. When the partner reports — signed — that it took the money, the
 * cart must be exactly what it was (same lines, same quantities, same prices)
 * and in stock; otherwise the link is refused and the partner told to return
 * the money. A used, refused or expired link never pays twice.
 */
/**
 * The partner app — split by job into ./partner/*.ts (review batch 2, ت-٩).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { partnerConfig } from "./partner/config.js";
export { enterFromPartner, partnerLinkOf, unlinkPartner } from "./partner/sign-in.js";
export {
  LINK_TTL_MS,
  createPaymentLink,
  paymentLinkStatus,
  completePaymentLink,
} from "./partner/links.js";
