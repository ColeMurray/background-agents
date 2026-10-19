import { describe, expect, it } from "vitest";
import { assembleSessionTextDiff } from "./assembler";
import {
  SESSION_DIFF_MAX_BUNDLE_BYTES,
  sessionDiffUploadSchema,
} from "@open-inspect/shared/types/session-diffs";

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

  it("deterministically omits files until a 1000-path bundle fits the wire envelope", async () => {
    const files = Array.from({ length: 1_000 }, (_, index) => ({
      path: `${String(index).padStart(4, "0")}-${"深".repeat(600)}.txt`,
      before: null,
      after: "x\n",
      mode: "100644" as const,
    }));

    const bundle = await assembleSessionTextDiff(
      [
        {
          position: 0,
          repoOwner: "group/subgroup",
          repoName: "same-name",
          baseSha: "a".repeat(40),
          files,
        },
      ],
      { triggerMessageId: null, capturedAt: 100 }
    );

    expect(() => sessionDiffUploadSchema.parse(bundle)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify(bundle)).byteLength).toBeLessThanOrEqual(
      SESSION_DIFF_MAX_BUNDLE_BYTES
    );
    expect(bundle.repositories[0]).toMatchObject({ truncated: true });
    const repository = bundle.repositories[0];
    if (repository?.status !== "ready") throw new Error("expected ready repository");
    expect(repository.files.length + repository.omittedFileCount).toBe(1_000);
    expect(repository.files.map((file) => file.path)).toEqual(
      [...repository.files.map((file) => file.path)].sort()
    );
  });

  it("resets truncation metadata independently on every multi-repository envelope probe", async () => {
    const tiny = {
      position: 0,
      repoOwner: "group/subgroup",
      repoName: "tiny",
      baseSha: "a".repeat(40),
      files: [{ path: "kept.txt", before: null, after: "x\n", mode: "100644" as const }],
    };
    const large = {
      position: 1,
      repoOwner: "group/subgroup",
      repoName: "large",
      baseSha: "b".repeat(40),
      files: Array.from({ length: 1_000 }, (_, index) => ({
        path: `${String(index).padStart(4, "0")}-${"深".repeat(600)}.txt`,
        before: null,
        after: "x\n",
        mode: "100644" as const,
      })),
    };

    const bundle = await assembleSessionTextDiff([large, tiny], {
      triggerMessageId: null,
      capturedAt: 100,
    });
    const first = bundle.repositories[0];
    const second = bundle.repositories[1];
    expect(first).toMatchObject({ position: 0, truncated: false, omittedFileCount: 0 });
    expect(second).toMatchObject({ position: 1, truncated: true });
    if (second?.status !== "ready") throw new Error("expected ready repository");
    expect(second.files.length + second.omittedFileCount).toBe(1_000);
  });
});
