/**
 * PG-2 — the static leak guard, as a vitest suite.
 *
 * The same three assertions also run inside `pg2.integration.mjs`, which IS a
 * blocking CI step; this wrapper exists so the guard can be run alone during
 * development (`pnpm exec vitest run --config vitest.backend.config.ts`) with a
 * readable failure list.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  findDeletedLeaks,
  formatViolations,
  staleAllowlistKeys,
} from "./helpers/deleted-leak-guard.js";

describe("PG-2 soft-delete leak guard", () => {
  it("finds no unfiltered read of a trashed row in phase1-backend/src", () => {
    const violations = findDeletedLeaks();
    expect(violations.length, `\n${formatViolations(violations)}\n`).toBe(0);
  });

  it("requires a written reason on every allowlist entry", () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(
        reason.trim().length,
        `allowlist entry ${key} needs a real reason`
      ).toBeGreaterThanOrEqual(20);
    }
  });

  it("carries no stale allowlist entry", () => {
    const stale = staleAllowlistKeys();
    expect(
      stale,
      `these allowlist entries silence nothing any more and must be deleted:\n  ${stale.join("\n  ")}`
    ).toEqual([]);
  });
});
