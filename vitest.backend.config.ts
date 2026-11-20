import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["phase1-backend/tests/**/*.test.ts"],
  },
});
