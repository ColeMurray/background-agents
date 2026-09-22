import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("lets clean CLI processes exit and bounds abandoned handles with an unsuccessful exit", async () => {
  const bundle = await build({
    entryPoints: [new URL("./process-exit.ts", import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const code = bundle.outputFiles[0].text + "\nboundProcessExit(100);";
  const exec = promisify(execFile);
  await expect(exec(process.execPath, ["-e", code], { timeout: 3000 })).resolves.toMatchObject({
    stderr: "",
  });
  await expect(
    exec(process.execPath, ["-e", code + "setInterval(() => {}, 1000);"], { timeout: 3000 })
  ).rejects.toMatchObject({
    code: 1,
    killed: false,
    stderr: expect.stringContaining("forcing exit"),
  });
});
