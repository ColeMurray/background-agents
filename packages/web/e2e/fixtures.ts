import { test as base, expect } from "@playwright/test";
import { resolve } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { PreviewStackHandle } from "../../control-plane/test/preview/contracts";

export const test = base.extend<{ preview: PreviewStackHandle }>({
  preview: [
    async ({ browserName: _browserName }, provide) => {
      const root = resolve(import.meta.dirname, "../../..");
      const bundleDir = await mkdtemp(join(tmpdir(), "oi-preview-e2e-"));
      let preview: PreviewStackHandle | undefined;
      try {
        // Use the same bundled Node graph as the CLI, including its JSON imports.
        const outfile = join(bundleDir, "stack.mjs");
        await build({
          entryPoints: [join(root, "packages/control-plane/test/preview/stack.ts")],
          outfile,
          bundle: true,
          platform: "node",
          target: "node22",
          format: "esm",
          external: ["node:*"],
          banner: {
            js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
          },
        });
        const module = (await import(pathToFileURL(outfile).href)) as {
          startPreviewStack(options: {
            root: string;
            scenario: "empty";
          }): Promise<PreviewStackHandle>;
        };
        preview = await module.startPreviewStack({ root, scenario: "empty" });
        await provide(preview);
        expect(preview.backend.failures()).toEqual([]);
      } finally {
        try {
          await preview?.close();
        } finally {
          await rm(bundleDir, { recursive: true, force: true });
        }
      }
    },
    { timeout: 180_000 },
  ],
  context: async ({ browser, preview }, provide) => {
    const context = await browser.newContext({
      storageState: preview.manifest.personas.member.statePath,
    });
    try {
      await provide(context);
    } finally {
      await context.close();
    }
  },
});
export { expect };
