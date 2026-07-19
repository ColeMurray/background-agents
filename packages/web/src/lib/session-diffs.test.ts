import { describe, expect, it } from "vitest";
import type { SessionDiffManifest, SessionDiffState } from "@open-inspect/shared";
import {
  buildUniquePathLabels,
  deriveSessionDiffView,
  parseDiffErrorBody,
  resolveDiffSelection,
} from "./session-diffs";

const manifest: SessionDiffManifest = {
  version: 1,
  revisionId: "revision-2",
  capturedAt: 200,
  triggerMessageId: "message-2",
  repositories: [
    {
      status: "ready",
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
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
        },
      ],
    },
  ],
};

describe("session diff view model", () => {
  it("keeps a selection by repository and path across latest revisions", () => {
    expect(
      resolveDiffSelection(manifest, { repositoryPosition: 0, path: "packages/web/src/index.ts" })
    ).toMatchObject({ revisionId: "revision-2", file: { id: "new-file-id" } });
  });

  it("reports a selected path that disappeared from the latest revision", () => {
    expect(resolveDiffSelection(manifest, { repositoryPosition: 0, path: "removed.ts" })).toEqual({
      status: "missing",
      revisionId: "revision-2",
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
      })
    ).toEqual({ kind: "hidden", showManifest: false, canRetry: false });
  });

  it("shows availability after execution and never derives a persistent capture state", () => {
    const state = diffState();
    expect(deriveSessionDiffView(input(state))).toMatchObject({
      kind: "available_after_execution",
    });
    expect(deriveSessionDiffView({ ...input(state), isProcessing: true })).toMatchObject({
      kind: "working",
      showManifest: false,
    });
  });

  it("keeps the previous bundle visible while the agent is working", () => {
    expect(
      deriveSessionDiffView({ ...input(diffState(manifest)), isProcessing: true })
    ).toMatchObject({ kind: "working", showManifest: true, canRetry: false });
  });

  it("keeps a previous bundle visible with a refresh failure and retry", () => {
    expect(
      deriveSessionDiffView(
        input({
          ...diffState(manifest),
          lastError: { message: "timed out", occurredAt: 300 },
        })
      )
    ).toMatchObject({
      kind: "failed",
      showManifest: true,
      canRetry: true,
      message: "timed out",
    });
  });

  it("prioritizes active execution over the previous refresh failure", () => {
    const state: SessionDiffState = {
      ...diffState(manifest),
      lastError: { message: "timed out", occurredAt: 300 },
    };
    expect(deriveSessionDiffView({ ...input(state), isProcessing: true })).toMatchObject({
      kind: "working",
      showManifest: true,
      canRetry: false,
    });
  });

  it("distinguishes a successful empty bundle from a missing baseline", () => {
    expect(
      deriveSessionDiffView(input(diffState({ ...manifest, repositories: [] })))
    ).toMatchObject({ kind: "empty" });
    expect(
      deriveSessionDiffView(
        input({ ...diffState(), unavailableReason: "Changes unavailable for this session" })
      )
    ).toMatchObject({
      kind: "unavailable",
      message: "Changes unavailable for this session",
    });
  });
});

describe("parseDiffErrorBody", () => {
  it("keeps only known codes and string error fields from untrusted bodies", () => {
    expect(parseDiffErrorBody({ code: "diff_revision_stale", error: "stale" })).toEqual({
      code: "diff_revision_stale",
      error: "stale",
    });
    expect(parseDiffErrorBody({ code: "diff_file_not_found" })).toEqual({
      code: "diff_file_not_found",
    });
    expect(parseDiffErrorBody({ code: 42, error: { message: "nope" } })).toEqual({});
    // Unknown code strings are dropped: the field is typed as the shared
    // SessionDiffErrorCode union, so only codes the UI acts on survive.
    expect(parseDiffErrorBody({ code: "some_future_code", error: "boom" })).toEqual({
      error: "boom",
    });
  });

  it("returns an empty body for non-object values", () => {
    expect(parseDiffErrorBody(null)).toEqual({});
    expect(parseDiffErrorBody("boom")).toEqual({});
    expect(parseDiffErrorBody(undefined)).toEqual({});
  });
});

function diffState(current: SessionDiffManifest | null = null): SessionDiffState {
  return { version: 1, current, lastError: null, unavailableReason: null };
}

function input(state: SessionDiffState) {
  return {
    hasRepository: true,
    isProcessing: false,
    state,
    isLoading: false,
  };
}
