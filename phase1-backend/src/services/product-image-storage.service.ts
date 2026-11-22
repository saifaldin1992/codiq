/**
 * Object storage — split by job into ./storage/*.ts (review batch 3, ت-٤).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { getProductImageBytes, getObjectRange } from "./storage/bucket.js";
export {
  detectedImageType,
  validateProductImage,
  validateStoreImage,
  validatePrescriptionImage,
  productImageConstraints,
  prescriptionImageConstraints,
  storeImageConstraints,
} from "./storage/validate.js";
export {
  renderProductImage,
  putProductImage,
  productImageObjectKeys,
  deleteProductImageObjects,
} from "./storage/products.js";
export {
  putPrescriptionImage,
  deletePrescriptionObjects,
  getPrescriptionBytes,
} from "./storage/prescriptions.js";
export {
  putStoreBanner,
  getStoreBannerBytes,
  deleteStoreBannerObjects,
  putStoreLogo,
  getStoreLogoBytes,
  deleteStoreLogoObjects,
  putStoreCover,
  deleteStoreCoverObjects,
  putMarketImage,
  deleteMarketImageObjects,
} from "./storage/store-images.js";
export {
  REEL_MAX_BYTES,
  reelVideoConstraints,
  detectReelVideo,
  putReelVideo,
} from "./storage/reels.js";
