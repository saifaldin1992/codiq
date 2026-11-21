/** zod shapes for reels. Upload fields arrive as multipart strings. */
import { z } from "zod";

export const reelUploadSchema = z.object({
  caption: z.string().trim().max(300).optional(),
  productId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
});
export const reelDecisionSchema = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() });
export const reelQueueQuerySchema = z.object({ status: z.enum(["pending", "approved", "rejected"]).optional(), cursor: z.string().max(512).optional(), limit: z.unknown().optional() });
export const reelFeedQuerySchema = z.object({ store: z.string().trim().max(120).optional(), cursor: z.string().max(512).optional(), limit: z.unknown().optional() });
export const reelLikeSchema = z.object({ liked: z.boolean() });
