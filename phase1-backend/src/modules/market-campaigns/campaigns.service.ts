/**
 * Marketplace M8a — campaigns and «عرض الساعة».
 *
 * The owner sets a campaign (its page, its days, its hours). A store puts its
 * products forward for an hour at a percentage off; the owner approves. During
 * the hour the product SELLS at the lower price — the store funds it, nothing
 * else moves: the price itself comes from codiq_live_price() wherever a price is
 * quoted or charged (see services/live-price.ts).
 *
 * Two rules keep the money honest:
 *   · a deal is fixed once its hour starts — no withdrawing, no re-deciding, no
 *     moving the hour — so the price a shopper was quoted is the price the store
 *     agreed to for exactly that hour;
 *   · a store can only put forward its own live product, at the campaign's
 *     minimum percentage or more, for an hour that has not started.
 */
/**
 * Campaigns — split by job into ./campaigns/*.ts (review batch 6, ت-٦).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  ownerCampaigns,
  createCampaign,
  updateCampaign,
  ownerCampaign,
  replaceCampaignDays,
  addSlot,
  deleteSlot,
} from "./campaigns/owner.js";
export {
  campaignDeals,
  decideDeal,
  storeCampaigns,
  proposeDeal,
  withdrawDeal,
} from "./campaigns/deals.js";
export { campaignPage, liveCampaigns } from "./campaigns/pages.js";
