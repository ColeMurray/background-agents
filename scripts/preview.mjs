import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePreview } from "./preview-bundle.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (
  Number(process.versions.node.split(".")[0]) < 22 ||
  (Number(process.versions.node.split(".")[0]) === 22 &&
    Number(process.versions.node.split(".")[1]) < 13)
)
  throw new Error("Preview requires Node >=22.13.0; see package.json");
let child;
// A terminal's Ctrl-C also reaches the child directly (same process group). Forwarding covers
// signals sent only to npm or this process; the CLI treats every repeat as one stop request.
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
let bundle;
try {
  await run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "packages/shared",
  ]);
  bundle = await bundlePreview("packages/control-plane/test/preview/cli.ts");
  await run(process.execPath, [bundle.file, "--root", root, ...process.argv.slice(2)]);
} finally {
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
  await bundle?.dispose();
}
