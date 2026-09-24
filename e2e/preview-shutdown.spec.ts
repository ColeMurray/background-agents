import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Ctrl-C, even pressed twice, stops the real launcher cleanly and frees the checkout", async () => {
  test.setTimeout(180_000);
  // A process group of its own, so the test can signal all of it the way a terminal's Ctrl-C does.
  const preview = spawn(
    process.execPath,
    ["scripts/preview.mjs", "--scenario", "empty", "--browser", "none"],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  preview.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  preview.stderr!.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    preview.once("exit", (code, signal) => resolve({ code, signal }))
  );
  try {
    await expect
      .poll(() => stdout.includes('{"status":"ready"') || preview.exitCode !== null, {
        timeout: 150_000,
      })
      .toBe(true);
    const ready = JSON.parse(
      stdout.split("\n").find((line) => line.startsWith('{"status":"ready"'))!
    ) as { run: string };
    process.kill(-preview.pid!, "SIGINT");
    // The second press lands while cleanup is still running. A group that is already gone is
    // judged by the exit and leftovers below, not by this send.
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(-preview.pid!, "SIGINT");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout).toContain('{"status":"stopped","clean":true}');
    expect(existsSync(join(root, ".preview/lock.json"))).toBe(false);
    expect(existsSync(dirname(ready.run))).toBe(false);
  } finally {
    // Never leak the launcher group, even when an assertion above failed.
    if (preview.exitCode === null && preview.signalCode === null)
      process.kill(-preview.pid!, "SIGKILL");
  }
});
