import { describe, expect, it } from "vitest";
import { sandboxEventSchema } from "./sandbox-events";
import { serverMessageSchema } from "./server-messages";
import {
  SESSION_DIFF_MAX_BUNDLE_BYTES,
  SESSION_DIFF_MAX_FILE_PATCH_BYTES,
  SESSION_DIFF_MAX_TOTAL_PATCH_BYTES,
  sessionDiffFailureSchema,
  sessionDiffStateSchema,
  sessionDiffUploadSchema,
  storedSessionDiffBundleSchema,
  toSessionDiffManifest,
} from "./session-diffs";

const readyRepository = {
  status: "ready" as const,
  position: 0,
  repoOwner: "open-inspect",
  repoName: "open-inspect",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  truncated: false,
  omittedFileCount: 0,
  files: [
    {
      id: "file-1",
      path: "packages/web/src/app.tsx",
      status: "modified" as const,
      additions: 2,
      deletions: 1,
      renderState: "renderable" as const,
      patch: "diff --git a/app.tsx b/app.tsx\n",
    },
  ],
};

const upload = {
  version: 1 as const,
  triggerMessageId: "message-1",
  capturedAt: 100,
  repositories: [readyRepository],
};

describe("session diff contracts", () => {
  it("accepts one bounded bundle containing renderable patches", () => {
    expect(sessionDiffUploadSchema.parse(upload)).toEqual(upload);
  });

  it("accepts a coherent partial multi-repository bundle", () => {
    const result = sessionDiffUploadSchema.parse({
      ...upload,
      repositories: [
        readyRepository,
        {
          status: "unavailable",
          position: 1,
          repoOwner: "group/subgroup",
          repoName: "api",
          baseSha: "c".repeat(40),
          error: "start commit is unavailable",
          files: [],
        },
      ],
    });

    expect(result.repositories).toHaveLength(2);
    expect(result.repositories[1]).toMatchObject({ status: "unavailable", files: [] });
  });

  it("removes patch text from the public manifest", () => {
    const stored = storedSessionDiffBundleSchema.parse({ revisionId: "revision-1", ...upload });
    const manifest = toSessionDiffManifest(stored);

    expect(manifest.repositories[0]?.files[0]).not.toHaveProperty("patch");
    expect(JSON.stringify(manifest)).not.toContain("diff --git");
  });

  it("rejects duplicate repository positions, identities, file ids, and current paths", () => {
    const unavailable = {
      status: "unavailable" as const,
      position: 0,
      repoOwner: "group/subgroup",
      repoName: "web",
      baseSha: "a".repeat(40),
      error: "missing commit",
      files: [] as [],
    };
    expect(() =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [unavailable, { ...unavailable, repoOwner: "other" }],
      })
    ).toThrow(/Duplicate repository position/);
    expect(() =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [
          unavailable,
          { ...unavailable, position: 1, repoOwner: "GROUP/SUBGROUP", repoName: "WEB" },
        ],
      })
    ).toThrow(/Duplicate repository identity/);
    expect(() =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [readyRepository, { ...readyRepository, position: 1, repoName: "api" }],
      })
    ).toThrow(/Duplicate diff file id/);
    expect(() =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [
          {
            ...readyRepository,
            files: [readyRepository.files[0], { ...readyRepository.files[0], id: "file-2" }],
          },
        ],
      })
    ).toThrow(/Duplicate diff file path/);
  });

  it("requires patches only for renderable files and old paths only for renames", () => {
    const parseFile = (file: Record<string, unknown>) =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [{ ...readyRepository, files: [file] }],
      });

    expect(() => parseFile({ ...readyRepository.files[0], patch: undefined })).toThrow(
      /require a patch/
    );
    expect(() =>
      parseFile({ ...readyRepository.files[0], renderState: "binary", patch: "not allowed" })
    ).toThrow(/cannot include a patch/);
    expect(() => parseFile({ ...readyRepository.files[0], oldPath: "src/old.ts" })).toThrow(
      /oldPath is only valid for renamed files/
    );
  });

  it("measures per-file and aggregate patch limits as UTF-8 bytes", () => {
    const emoji = "😀";
    expect(() =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [
          {
            ...readyRepository,
            files: [
              {
                ...readyRepository.files[0],
                patch: emoji.repeat(SESSION_DIFF_MAX_FILE_PATCH_BYTES / 4 + 1),
              },
            ],
          },
        ],
      })
    ).toThrow(/Patch exceeds/);

    const patch = "x".repeat(Math.floor(SESSION_DIFF_MAX_TOTAL_PATCH_BYTES / 3));
    expect(() =>
      sessionDiffUploadSchema.parse({
        ...upload,
        repositories: [
          {
            ...readyRepository,
            files: Array.from({ length: 4 }, (_, index) => ({
              ...readyRepository.files[0],
              id: `file-${index}`,
              path: `src/${index}.ts`,
              patch,
            })),
          },
        ],
      })
    ).toThrow(/patch bytes/);
  });

  it("rejects an encoded bundle above the storage budget", () => {
    const files = Array.from({ length: 400 }, (_, index) => ({
      id: `file-${index}`,
      path: `${"nested/".repeat(580)}${index}.ts`,
      status: "modified" as const,
      additions: null,
      deletions: null,
      renderState: "metadata_only" as const,
    }));
    const oversized = { ...upload, repositories: [{ ...readyRepository, files }] };

    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      SESSION_DIFF_MAX_BUNDLE_BYTES
    );
    expect(() => sessionDiffUploadSchema.parse(oversized)).toThrow(/Encoded bundle exceeds/);
  });

  it("does not charge the separately stored revision id against bundle_json", () => {
    const files: Array<{
      id: string;
      path: string;
      status: "modified";
      additions: null;
      deletions: null;
      renderState: "metadata_only";
    }> = [];
    const withFiles = () => ({
      ...upload,
      repositories: [{ ...readyRepository, files }],
    });
    const bytes = () => new TextEncoder().encode(JSON.stringify(withFiles())).byteLength;
    const targetBytes = SESSION_DIFF_MAX_BUNDLE_BYTES - 20;
    while (true) {
      const index = files.length;
      const next = {
        id: `file-${index}`,
        path: `${index}-${"x".repeat(4_000)}`,
        status: "modified" as const,
        additions: null,
        deletions: null,
        renderState: "metadata_only" as const,
      };
      files.push(next);
      if (bytes() <= targetBytes) continue;
      files.pop();
      break;
    }
    const index = files.length;
    let low = 1;
    let high = 4_000;
    let best = 0;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      files.push({
        id: `file-${index}`,
        path: `${index}-${"y".repeat(length)}`,
        status: "modified",
        additions: null,
        deletions: null,
        renderState: "metadata_only",
      });
      const fits = bytes() <= targetBytes;
      files.pop();
      if (fits) {
        best = length;
        low = length + 1;
      } else {
        high = length - 1;
      }
    }
    if (best > 0) {
      files.push({
        id: `file-${index}`,
        path: `${index}-${"y".repeat(best)}`,
        status: "modified",
        additions: null,
        deletions: null,
        renderState: "metadata_only",
      });
    }
    expect(SESSION_DIFF_MAX_BUNDLE_BYTES - bytes()).toBeLessThan(220);
    const parsedUpload = sessionDiffUploadSchema.parse(withFiles());

    expect(() =>
      storedSessionDiffBundleSchema.parse({
        revisionId: "r".repeat(200),
        ...parsedUpload,
      })
    ).not.toThrow();
  });

  it("parses the public state and bounded failure request", () => {
    const current = toSessionDiffManifest(
      storedSessionDiffBundleSchema.parse({ revisionId: "revision-1", ...upload })
    );
    expect(
      sessionDiffStateSchema.parse({
        version: 1,
        current,
        lastError: { message: "latest refresh failed", occurredAt: 200 },
        unavailableReason: null,
      })
    ).toMatchObject({ current: { revisionId: "revision-1" } });
    expect(sessionDiffFailureSchema.parse({ error: "timed out" })).toEqual({ error: "timed out" });
  });

  it("reports immutable baselines on ready without a diff capability gate", () => {
    expect(
      sandboxEventSchema.parse({
        type: "ready",
        sandboxId: "sandbox-1",
        timestamp: 100,
        repositories: [
          {
            position: 0,
            repoOwner: "open-inspect",
            repoName: "open-inspect",
            baseSha: "a".repeat(40),
          },
        ],
      })
    ).toMatchObject({ repositories: [{ baseSha: "a".repeat(40) }] });
  });

  it("parses lightweight invalidations without capture attempt state", () => {
    expect(
      serverMessageSchema.parse({
        type: "diff_state_changed",
        revisionId: "revision-1",
        updatedAt: 100,
      })
    ).toEqual({ type: "diff_state_changed", revisionId: "revision-1", updatedAt: 100 });
  });
});
