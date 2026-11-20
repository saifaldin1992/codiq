import { createApp } from "./http/app.js";
import { config } from "./config.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logging/logger.js";

const server = createApp().listen(config.port, () => {
  logger.info(`codiq phase 1 API listening on http://127.0.0.1:${config.port}`, { port: config.port });
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
