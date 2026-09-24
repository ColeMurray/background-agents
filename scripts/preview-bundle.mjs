/**
 * The preview's one bundling policy. The launcher runs its CLI from a bundle and the browser suite
 * imports the stack from one, so both run the same Node graph, JSON imports included.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/** @import { StartPreviewStack } from "../packages/control-plane/test/preview/contracts" */

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Bundles a repository-relative entry into a private temporary directory.
 * @param {string} entry
 * @returns {Promise<{ file: string; dispose(): Promise<void> }>}
 */
export async function bundlePreview(entry) {
  const directory = await mkdtemp(join(tmpdir(), "oi-preview-bundle-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const file = join(directory, "preview.mjs");
  try {
    await build({
      entryPoints: [join(root, entry)],
      outfile: file,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["node:*"],
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return { file, dispose };
}

/**
 * The real stack for an in-process caller such as the browser suite, behind the dependency-free
 * contract that `stack.ts` is typechecked against. Dispose only after the stack has closed.
 * @returns {Promise<{ startPreviewStack: StartPreviewStack; dispose(): Promise<void> }>}
 */
export async function importPreviewStack() {
  const bundle = await bundlePreview("packages/control-plane/test/preview/stack.ts");
  try {
    const { startPreviewStack } = await import(pathToFileURL(bundle.file).href);
    if (typeof startPreviewStack !== "function")
      throw new Error("preview bundle does not export startPreviewStack");
    return { startPreviewStack, dispose: bundle.dispose };
  } catch (error) {
    await bundle.dispose();
    throw error;
  }
}
