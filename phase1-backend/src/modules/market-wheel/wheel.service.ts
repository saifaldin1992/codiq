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
/**
 * Prize wheel — split by job into ./wheel/*.ts (review batch 6, ت-٢).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { baghdadDay, wheelPage, spin } from "./wheel/play.js";
export { myWins, claimWin, leaderboard, spinLog } from "./wheel/wins.js";
export {
  ownerWheels,
  saveWheel,
  addPrize,
  updatePrize,
  winsQueue,
  setWinStatus,
  wheelReport,
  supportSpins,
} from "./wheel/owner.js";
