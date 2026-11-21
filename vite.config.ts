import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

/**
 * ق-217 — the scaffold this repository was generated from is gone from the
 * product, not only from `package.json`.
 *
 * Phase 10 removed the generator's runtime plugin and its siblings from the
 * dependency list and recorded its storage proxy as deleted. Two pieces of it
 * were still here: a debug-collector plugin that injected a 26 KB console,
 * network and SESSION-REPLAY capture script into the served document whenever
 * the build ran with a NODE_ENV that was not exactly "production" — the very
 * condition ق-137 caught Railway's builder in — and a presign proxy pointing at
 * a storage API this platform does not use. Neither could do anything useful in
 * production; both shipped, and one of them collected a shopper's session.
 *
 * `template-residue.guard.mjs` refuses their return, which is why this comment
 * names none of their paths: the guard greps for them.
 */
const plugins = [react(), tailwindcss()];

export default defineConfig(({ command }) => {
  /**
   * ق-137 hard lesson (2026-09-01): Vite lets an inherited NODE_ENV OVERRIDE the
   * build mode — `NODE_ENV=development pnpm build` quietly produces a
   * DEVELOPMENT-condition bundle: jsxDEV transforms, react.development runtime,
   * every chunk ~59% fatter raw and ~18% fatter gzipped, and a slower React for
   * every real user. That is exactly what production was serving: Railway's
   * build environment carried a non-production NODE_ENV (the start command's
   * `NODE_ENV=production` applies only at runtime, after the damage), so the
   * deployed entry weighed 199.6 KB gzip where the same commit built locally at
   * 135.6 KB. Forcing it here — for the build command only, never the dev
   * server — makes the artifact deterministic on every machine and platform.
   * perf-budget.guard.mjs also fails the build outright if dev-runtime markers
   * ever reach a served chunk again, whatever the cause.
   */
  if (command === "build") {
    process.env.NODE_ENV = "production";
  }
  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      },
    },
    envDir: path.resolve(import.meta.dirname),
    root: path.resolve(import.meta.dirname, "client"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
      // POS-offline v1: scripts/generate-sw-manifest.mjs derives the till's
      // service-worker precache from .vite/manifest.json after every build.
      manifest: true,
    },
    server: {
      port: 3000,
      strictPort: false, // Will find next available port if 3000 is busy
      host: true,
      allowedHosts: [
        ".manuspre.computer",
        ".manus.computer",
        ".manus-asia.computer",
        ".manuscomputer.ai",
        ".manusvm.computer",
        "localhost",
        "127.0.0.1",
      ],
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
  };
});
