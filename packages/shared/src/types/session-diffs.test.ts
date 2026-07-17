import { describe, expect, it } from "vitest";
import {
  diffCaptureCompleteRequestSchema,
  diffCaptureFailureRequestSchema,
  sessionDiffManifestSchema,
  sessionDiffStateSchema,
} from "./session-diffs";
import { MAX_SESSION_REPOSITORIES } from "./repositories";
import { sandboxEventSchema } from "./sandbox-events";
import { serverMessageSchema } from "./server-messages";

describe("session diff contracts", () => {
  it("parses a latest session diff manifest", () => {
    const result = sessionDiffStateSchema.safeParse({
      version: 1,
      baseline: { status: "ready", reason: null },
      attempt: { id: null, status: "idle", startedAt: null, error: null },
      current: {
        revisionId: "capture-1",
        capturedAt: 100,
        triggerMessageId: "message-1",
        repositories: [
          {
            position: 0,
            repoOwner: "open-inspect",
            repoName: "open-inspect",
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            capturedAt: 100,
            status: "ready",
            sourceCaptureId: "capture-1",
            truncated: false,
            omittedFileCount: 0,
            files: [
              {
                id: "file-1",
                path: "packages/web/src/app.tsx",
                status: "modified",
                additions: 2,
                deletions: 1,
                renderState: "renderable",
                patchBytes: 128,
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects duplicate file ids and paths inside a repository", () => {
    const result = sessionDiffStateSchema.safeParse({
      version: 1,
      baseline: { status: "ready", reason: null },
      attempt: { id: null, status: "idle", startedAt: null, error: null },
      current: {
        revisionId: "capture-1",
        capturedAt: 100,
        triggerMessageId: null,
        repositories: [
          {
            position: 0,
            repoOwner: "open-inspect",
            repoName: "open-inspect",
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            capturedAt: 100,
            status: "ready",
            sourceCaptureId: "capture-1",
            truncated: false,
            omittedFileCount: 0,
            files: [
              {
                id: "file-1",
                path: "src/app.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                renderState: "renderable",
                patchBytes: 10,
              },
              {
                id: "file-1",
                path: "src/app.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                renderState: "renderable",
                patchBytes: 10,
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("preserves session diff capability and immutable baselines on ready", () => {
    const result = sandboxEventSchema.parse({
      type: "ready",
      sandboxId: "sandbox-1",
      timestamp: 100,
      capabilities: ["session_diff_v1"],
      repositories: [
        {
          position: 0,
          repoOwner: "open-inspect",
          repoName: "open-inspect",
          baseSha: "a".repeat(40),
        },
      ],
    });

    expect(result).toMatchObject({
      capabilities: ["session_diff_v1"],
      repositories: [{ baseSha: "a".repeat(40) }],
    });
  });

  it("parses lightweight session diff invalidation messages", () => {
    const result = serverMessageSchema.safeParse({
      type: "diff_state_changed",
      attemptStatus: "capturing",
      revisionId: "capture-1",
      updatedAt: 100,
    });

    expect(result.success).toBe(true);
  });

  it("validates successful and failed repository capture outcomes", () => {
    const result = diffCaptureCompleteRequestSchema.parse({
      repositories: [
        {
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          truncated: false,
          omittedFileCount: 0,
          files: [
            {
              id: "file-1",
              path: "src/app.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              renderState: "renderable",
              patchBytes: 120,
            },
          ],
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "api",
          baseSha: "c".repeat(40),
          error: "checkout unavailable",
        },
      ],
    });

    expect(result.repositories).toHaveLength(2);
    expect(diffCaptureFailureRequestSchema.parse({ error: "timed out" })).toEqual({
      error: "timed out",
    });
  });

  it("rejects duplicate repository positions in a capture", () => {
    const outcome = {
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      error: "failed",
    };

    expect(() =>
      diffCaptureCompleteRequestSchema.parse({ repositories: [outcome, outcome] })
    ).toThrow(/Duplicate repository position/);
  });

  it("bounds repository counts in capture requests and persisted manifests", () => {
    const captureRepositories = Array.from(
      { length: MAX_SESSION_REPOSITORIES + 1 },
      (_, position) => ({
        position,
        repoOwner: "acme",
        repoName: `repo-${position}`,
        baseSha: "a".repeat(40),
        error: "unavailable",
      })
    );
    expect(() =>
      diffCaptureCompleteRequestSchema.parse({ repositories: captureRepositories })
    ).toThrow();

    expect(() =>
      sessionDiffManifestSchema.parse({
        revisionId: "capture-1",
        capturedAt: 100,
        triggerMessageId: null,
        repositories: captureRepositories.map((repository) => ({
          ...repository,
          headSha: "b".repeat(40),
          capturedAt: 100,
          status: "unavailable",
          sourceCaptureId: "capture-1",
          truncated: false,
          omittedFileCount: 0,
          files: [],
        })),
      })
    ).toThrow();
  });

  it("rejects duplicate file ids across repositories", () => {
    const file = {
      id: "shared-file-id",
      path: "src/app.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      renderState: "renderable" as const,
      patchBytes: 120,
    };

    expect(() =>
      diffCaptureCompleteRequestSchema.parse({
        repositories: [
          {
            position: 0,
            repoOwner: "acme",
            repoName: "web",
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            truncated: false,
            omittedFileCount: 0,
            files: [file],
          },
          {
            position: 1,
            repoOwner: "acme",
            repoName: "api",
            baseSha: "c".repeat(40),
            headSha: "d".repeat(40),
            truncated: false,
            omittedFileCount: 0,
            files: [{ ...file, path: "src/server.ts" }],
          },
        ],
      })
    ).toThrow(/Duplicate diff file id/);
  });

  it("rejects duplicate file paths inside a capture repository", () => {
    const file = {
      path: "src/app.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      renderState: "renderable" as const,
      patchBytes: 120,
    };

    expect(() =>
      diffCaptureCompleteRequestSchema.parse({
        repositories: [
          {
            position: 0,
            repoOwner: "acme",
            repoName: "web",
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            truncated: false,
            omittedFileCount: 0,
            files: [
              { ...file, id: "deleted-file" },
              { ...file, id: "untracked-file", status: "added" as const },
            ],
          },
        ],
      })
    ).toThrow(/Duplicate diff file path/);
  });

  it("enforces capture-wide file and patch-byte budgets", () => {
    const repository = (position: number, count: number, patchBytes: number) => ({
      position,
      repoOwner: "acme",
      repoName: `repo-${position}`,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: Array.from({ length: count }, (_, index) => ({
        id: `file-${position}-${index}`,
        path: `src/${index}.ts`,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        renderState: "renderable" as const,
        patchBytes,
      })),
    });

    expect(() =>
      diffCaptureCompleteRequestSchema.parse({
        repositories: [repository(0, 600, 1), repository(1, 401, 1)],
      })
    ).toThrow(/capture.*1,000 files/i);
    expect(() =>
      diffCaptureCompleteRequestSchema.parse({
        repositories: [repository(0, 21, 1_000_000)],
      })
    ).toThrow(/capture.*20,000,000 patch bytes/i);
  });

  it("requires patch metadata only for renderable files", () => {
    const outcome = {
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: [
        {
          id: "file-1",
          path: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          renderState: "renderable",
        },
      ],
    };
    expect(() => diffCaptureCompleteRequestSchema.parse({ repositories: [outcome] })).toThrow(
      /Renderable files require patchBytes/
    );
    expect(() =>
      diffCaptureCompleteRequestSchema.parse({
        repositories: [
          {
            ...outcome,
            files: [{ ...outcome.files[0], renderState: "binary", patchBytes: 10 }],
          },
        ],
      })
    ).toThrow(/Non-renderable files cannot include patchBytes/);
  });
});
