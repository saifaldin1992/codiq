/**
 * An order's status in the shopper's words — one map for every server surface that shows it: the
 * market's «طلباتي» (moved here from market-cart/checkout/orders.ts) and the status mail (review
 * batch 5, ت-٤), which used to print the database codes («من processing إلى out_for_delivery»).
 */
export const ORDER_STATUS_LABELS_AR: Record<string, string> = {
  new: "قيد المراجعة",
  processing: "تم القبول",
  preparation: "قيد التجهيز",
  out_for_delivery: "في الطريق إليك",
  completed: "تم التسليم",
  cancelled: "ملغي",
  rejected: "مرفوض",
  returned: "مُرجع",
};
