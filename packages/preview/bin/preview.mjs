// Runs the preview CLI in this process. The launcher imports the control plane's TypeScript, which
// uses extensionless imports Node cannot load, so it runs from a private esbuild bundle with the
// same settings as control-plane's `build:node`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "oi-preview-bundle-"));
let runCli;
try {
  const outfile = join(directory, "cli.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["node:*"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  ({ runCli } = await import(pathToFileURL(outfile).href));
} finally {
  // The bundle is fully loaded once imported; nothing reads it again.
  await rm(directory, { recursive: true, force: true });
}
await runCli(process.argv.slice(2), root);
