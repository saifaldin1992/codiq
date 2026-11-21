/** zod shapes for image search. The photo itself is multipart and checked by its bytes. */
import { z } from "zod";

export const imageIndexRunSchema = z.object({ limit: z.number().int().min(1).max(500).optional().default(100) });
