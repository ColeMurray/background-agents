import { test as base, expect } from "@playwright/test";
import { resolve } from "node:path";
import { importPreviewStack } from "../scripts/preview-bundle.mjs";
import type { PreviewStackHandle } from "../packages/control-plane/test/preview/contracts";

export const test = base.extend<{ preview: PreviewStackHandle }>({
  preview: [
    async ({ browserName: _browserName }, provide) => {
      // The same bundled Node graph as the launcher, reached through the typed stack contract.
      const { startPreviewStack, dispose } = await importPreviewStack();
      let preview: PreviewStackHandle | undefined;
      try {
        preview = await startPreviewStack({
          root: resolve(import.meta.dirname, ".."),
          scenario: "empty",
        });
        let failure: Error | undefined;
        void preview.failure.then((error) => {
          failure = error;
        });
        await provide(preview);
        // Judged before the close below, which stops Next and the fixtures on purpose.
        expect(failure).toBeUndefined();
        expect(preview.backend.failures()).toEqual([]);
      } finally {
        try {
          await preview?.close();
        } finally {
          await dispose();
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
