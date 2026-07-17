import { describe, expect, it } from "vitest";
import type { SessionDiffManifest, SessionDiffState } from "@open-inspect/shared";
import {
  buildUniquePathLabels,
  deriveSessionDiffView,
  resolveDiffSelection,
} from "./session-diffs";

const manifest: SessionDiffManifest = {
  revisionId: "capture-2",
  capturedAt: 200,
  triggerMessageId: "message-2",
  repositories: [
    {
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      capturedAt: 200,
      status: "ready",
      sourceCaptureId: "capture-2",
      truncated: false,
      omittedFileCount: 0,
      files: [
        {
          id: "new-file-id",
          path: "packages/web/src/index.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          renderState: "renderable",
          patchBytes: 100,
        },
      ],
    },
  ],
};

describe("session diff view model", () => {
  it("keeps a selection by repository and path across latest revisions", () => {
    expect(
      resolveDiffSelection(manifest, { repositoryPosition: 0, path: "packages/web/src/index.ts" })
    ).toMatchObject({ revisionId: "capture-2", file: { id: "new-file-id" } });
  });

  it("reports a selected path that disappeared from the latest revision", () => {
    expect(resolveDiffSelection(manifest, { repositoryPosition: 0, path: "removed.ts" })).toEqual({
      status: "missing",
      revisionId: "capture-2",
    });
  });

  it("builds shortest unique parent labels for duplicate basenames", () => {
    expect(
      buildUniquePathLabels(["packages/web/index.ts", "packages/api/index.ts", "README.md"])
    ).toEqual({
      "packages/web/index.ts": "web/index.ts",
      "packages/api/index.ts": "api/index.ts",
      "README.md": "README.md",
    });
  });

  it("omits Changes for sessions without repositories", () => {
    expect(
      deriveSessionDiffView({
        hasRepository: false,
        isProcessing: false,
        state: null,
        isLoading: false,
        hasError: false,
      })
    ).toEqual({ kind: "hidden", showManifest: false, canRetry: false });
  });

  it("distinguishes first execution, active work, and capture refresh states", () => {
    const state = diffState();
    expect(deriveSessionDiffView(input(state))).toMatchObject({
      kind: "available_after_execution",
    });
    expect(deriveSessionDiffView({ ...input(state), isProcessing: true })).toMatchObject({
      kind: "working",
    });
    expect(
      deriveSessionDiffView({
        ...input({
          ...state,
          attempt: { id: "capture-3", status: "capturing", startedAt: 300, error: null },
        }),
      })
    ).toMatchObject({ kind: "capturing", showManifest: false });
  });

  it("keeps a previous manifest visible while working, capturing, or failed", () => {
    const state = diffState(manifest);
    expect(deriveSessionDiffView({ ...input(state), isProcessing: true })).toMatchObject({
      kind: "working",
      showManifest: true,
    });
    expect(
      deriveSessionDiffView({
        ...input({
          ...state,
          attempt: { id: "capture-3", status: "capturing", startedAt: 300, error: null },
        }),
      })
    ).toMatchObject({ kind: "capturing", showManifest: true });
    expect(
      deriveSessionDiffView({
        ...input({
          ...state,
          attempt: { id: "capture-3", status: "failed", startedAt: 300, error: "timed out" },
        }),
      })
    ).toMatchObject({ kind: "failed", showManifest: true, canRetry: true });
  });

  it("distinguishes a successful empty capture from unavailable changes", () => {
    expect(
      deriveSessionDiffView(input(diffState({ ...manifest, repositories: [] })))
    ).toMatchObject({
      kind: "empty",
    });
    expect(
      deriveSessionDiffView(
        input({
          ...diffState(),
          baseline: { status: "unavailable", reason: "legacy session" },
        })
      )
    ).toMatchObject({ kind: "unavailable", message: "legacy session" });
  });
});

function diffState(current: SessionDiffManifest | null = null): SessionDiffState {
  return {
    version: 1,
    baseline: { status: "ready", reason: null },
    attempt: { id: null, status: "idle", startedAt: null, error: null },
    current,
  };
}

function input(state: SessionDiffState) {
  return {
    hasRepository: true,
    isProcessing: false,
    state,
    isLoading: false,
    hasError: false,
  };
}
