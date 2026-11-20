import { PrismaClient } from "@prisma/client";
import { resolveCodiqDatabaseUrl } from "./database-url.js";

// Prisma reads DATABASE_URL from the generated schema at client creation time.
// Prefer the dedicated CODIQ secret so the platform-provided DATABASE_URL remains untouched.
process.env.DATABASE_URL = resolveCodiqDatabaseUrl();
export const prisma = new PrismaClient();
