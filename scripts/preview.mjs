import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (
  Number(process.versions.node.split(".")[0]) < 22 ||
  (Number(process.versions.node.split(".")[0]) === 22 &&
    Number(process.versions.node.split(".")[1]) < 13)
)
  throw new Error("Preview requires Node >=22.13.0; see package.json");
let child;
const forward = (signal) => child?.kill(signal);
const onInt = () => forward("SIGINT");
const onTerm = () => forward("SIGTERM");
process.on("SIGINT", onInt);
process.on("SIGTERM", onTerm);
async function run(command, args) {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Preview command exited ${code}`))
    );
  });
}
const directory = await mkdtemp(join(tmpdir(), "oi-preview-bundle-"));
try {
  await run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "packages/shared",
  ]);
  const bundle = join(directory, "preview.mjs");
  await build({
    entryPoints: [join(root, "packages/control-plane/test/preview/cli.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["node:*"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  await run(process.execPath, [bundle, "--root", root, ...process.argv.slice(2)]);
} finally {
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
  await rm(directory, { recursive: true, force: true });
}
