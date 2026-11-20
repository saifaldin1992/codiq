/**
 * Killing a spawned child — and whatever it started.
 *
 * WINDOWS: the moto S3 emulator is spawned with `shell: true` because
 * `moto_server` is a .exe shim on PATH that `spawn` cannot resolve directly.
 * That puts cmd.exe between us and the real process, so `child.kill()` reaps
 * only the shell. `taskkill /T` walks the tree instead.
 *
 * POSIX — the same trap, which this file used to say did not exist. With
 * `shell: true` the child is `/bin/sh -c "node dist/index.js"`, and dash does
 * not exec the command: SIGTERM to the child kills the SHELL and orphans the
 * real server. Measured 2026-11-20: the server a passing `brand:test` started
 * was still alive 20 minutes later, and its notification worker kept claiming
 * outbox rows in the shared test database — so a LATER suite (`phase20b2`)
 * found its recovery email already consumed as «no_provider_configured» and
 * failed one run in two. So the shell's children are signalled first, then the
 * shell. The server's own SIGTERM handler stops its worker child (ADR-004).
 */
import { spawnSync } from "node:child_process";

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  if (child.pid) spawnSync("pkill", ["-TERM", "-P", String(child.pid)], { stdio: "ignore" });
  child.kill("SIGTERM");
}
