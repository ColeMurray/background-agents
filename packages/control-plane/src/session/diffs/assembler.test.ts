import { describe, expect, it } from "vitest";
import { assembleSessionTextDiff } from "./assembler";

describe("assembleSessionTextDiff", () => {
  it("assembles canonical bounded patches for repository text overlays", async () => {
    const bundle = await assembleSessionTextDiff(
      [
        {
          position: 0,
          repoOwner: "acme",
          repoName: "app",
          baseSha: "a".repeat(40),
          files: [
            {
              path: "src/index.ts",
              before: "const value = 1;\n",
              after: "const value = 2;\n",
              mode: "100644",
            },
          ],
        },
      ],
      { triggerMessageId: "message-1", capturedAt: 100, fileId: async () => "file-1" }
    );

    expect(bundle).toMatchObject({
      triggerMessageId: "message-1",
      capturedAt: 100,
      repositories: [
        {
          baseSha: "a".repeat(40),
          files: [
            {
              id: "file-1",
              path: "src/index.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              renderState: "renderable",
            },
          ],
        },
      ],
    });
    expect(bundle.repositories[0]?.files[0]?.patch).toContain(
      "diff --git a/src/index.ts b/src/index.ts"
    );
  });
});
