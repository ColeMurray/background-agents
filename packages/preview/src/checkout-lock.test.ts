import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireCheckoutLock } from "./checkout-lock";

let directory: string;
let lockPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "oi-preview-lock-test-"));
  lockPath = join(directory, "lock.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("an old release never removes a newer acquisition, even with the same PID", async () => {
  const releaseOld = acquireCheckoutLock(lockPath);
  await rm(lockPath);
  const releaseNew = acquireCheckoutLock(lockPath);
  const replacement = await readFile(lockPath, "utf8");
  try {
    releaseOld();
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
  } finally {
    releaseNew();
  }
  releaseOld();
  releaseNew();
  await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("only one concurrent process takes over a stale lock, including after SIGKILL", async () => {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(lockPath, JSON.stringify({ pid }));
  // Bundle the production module so separate Node processes exercise the real OS locking.
  const modulePath = join(directory, "checkout-lock.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "checkout-lock.ts")],
    outfile: modulePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const script = `
    import { once } from "node:events";
    import { acquireCheckoutLock } from "./checkout-lock.mjs";
    process.stdout.write("ready\\n");
    await once(process.stdin, "data");
    try {
      const release = acquireCheckoutLock(process.argv[1]);
      process.stdout.write("acquired\\n");
      await once(process.stdin, "data");
      release();
    } catch (error) {
      process.stdout.write(error.message.includes("checkout already owned") ? "owned\\n" : error.message + "\\n");
    }
    process.stdin.destroy();
  `;
  const contenders = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = createInterface({ input: child.stdout });
    const lines = output[Symbol.asyncIterator]();
    const exited = once(child, "exit");
    return { child, output, lines, exited };
  });
  try {
    const ready = await Promise.all(
      contenders.map(async ({ lines }) => (await lines.next()).value)
    );
    expect(ready).toEqual(Array(4).fill("ready"));
    for (const { child } of contenders) child.stdin.write("take\n");
    const results = await Promise.all(
      contenders.map(async ({ lines }) => (await lines.next()).value)
    );
    expect(results.filter((result) => result === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result === "owned")).toHaveLength(3);
    const winner = contenders[results.indexOf("acquired")];
    await Promise.all(
      contenders.filter((contender) => contender !== winner).map(({ exited }) => exited)
    );
    expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(winner.child.pid);
    expect(() => acquireCheckoutLock(lockPath)).toThrow("checkout already owned");

    winner.child.kill("SIGKILL");
    await winner.exited;
    const release = acquireCheckoutLock(lockPath);
    expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(process.pid);
    release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    for (const { child } of contenders) child.kill("SIGKILL");
    await Promise.all(contenders.map(({ exited }) => exited));
    for (const { output } of contenders) output.close();
  }
}, 15_000);
