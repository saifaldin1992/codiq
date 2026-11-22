/**
 * What a market shopper reads when a request fails (review batch 2, م-١).
 *
 * The server's message when it is Arabic — the market's own refusals are, and are often the
 * more precise («المتوفّر من هذا الخيار ٣ فقط»). The shared checkout's are partly English, and
 * the storefront has always translated those by CODE; the market now does the same, with the
 * same table, and never puts an English sentence on the screen.
 */
import { ERROR_TEXT } from "../lib/error-text";
import type { ApiErrorCode } from "../lib/storefront-api";

const ARABIC = /[؀-ۿ]/;

export function marketErrorText(
  code: string | null | undefined,
  message: string | null | undefined
) {
  if (message && ARABIC.test(message)) return message;
  return (code && ERROR_TEXT[code as ApiErrorCode]) || "تعذّر إتمام العملية، حاول مرة أخرى.";
}
