/**
 * ESLint — code quality and security lint for the whole repository.
 *
 * Errors are things that are wrong (or dangerous) wherever they appear. The
 * rest are warnings, held by a ratchet (`tools/lint-ratchet.mjs`): CI fails if
 * the warning count RISES above the recorded baseline, so new code is clean and
 * the old debt can only shrink. Lower the baseline when you fix some.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/node_modules/**",
      "docs/**",
      "deploy/cloudflare/.wrangler*/**",
      "client/public/**",
      "phase1-backend/src/http/openapi.document.ts",
      "client/src/components/ui/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // ── security: errors ─────────────────────────────────────────────────
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-child-process": "warn",
      "security/detect-non-literal-require": "error",
      "security/detect-unsafe-regex": "warn",
      "security/detect-buffer-noassert": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-new-buffer": "error",
      // Noise for this codebase: every bracket access on a typed record trips it.
      "security/detect-object-injection": "off",
      // Paths are built from constants and config, reviewed case by case.
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-possible-timing-attacks": "warn",
      // ── correctness ──────────────────────────────────────────────────────
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      // Off: every hit is the resolve-by-callback idiom
      // (`new Promise((resolve) => server.close(resolve))`), which returns nothing meaningful.
      "no-promise-executor-return": "off",
      // `let payload = null; try { payload = JSON.parse(text) } catch {}` — ratcheted, not a bug.
      "no-useless-assignment": "warn",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
      eqeqeq: ["error", "smart"],
      // ── debt, ratcheted as warnings ──────────────────────────────────────
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-require-imports": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
    },
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Tests and scripts spawn processes and read files by computed path by design.
    files: [
      "phase1-backend/tests/**",
      "phase1-backend/scripts/**",
      "scripts/**",
      "tools/**",
      "**/*.mjs",
    ],
    rules: {
      "security/detect-child-process": "off",
      "security/detect-non-literal-fs-filename": "off",
      // A thrown test failure that names the symptom is the point; a `cause` adds nothing.
      "preserve-caught-error": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
