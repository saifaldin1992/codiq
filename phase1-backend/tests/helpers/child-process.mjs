/**
 * Killing a spawned child on Windows.
 *
 * The moto S3 emulator is spawned with `shell: true` on Windows because
 * `moto_server` is a .exe shim on PATH that `spawn` cannot resolve directly.
 * That puts cmd.exe between us and the real process, so `child.kill()` reaps
 * only the shell — moto keeps the port. The next run of the same suite then
 * silently binds nothing, talks to the previous run's emulator, and fails far
 * away from the cause. `taskkill /T` walks the tree instead.
 *
 * On POSIX the plain kill is already correct, so nothing changes in CI.
 */
import { spawnSync } from "node:child_process";

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}
