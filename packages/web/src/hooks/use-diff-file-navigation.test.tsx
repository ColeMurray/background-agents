// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionDiffManifest } from "@open-inspect/shared";
import { useDiffFileNavigation } from "./use-diff-file-navigation";

const manifest: SessionDiffManifest = {
  version: 1,
  revisionId: "revision-1",
  capturedAt: 100,
  triggerMessageId: "message-1",
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
          id: "file-1",
          path: "src/app.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          renderState: "renderable",
        },
        {
          id: "file-2",
          path: "src/lib.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          renderState: "renderable",
        },
      ],
    },
    {
      status: "ready",
      position: 1,
      repoOwner: "acme",
      repoName: "api",
      baseSha: "c".repeat(40),
      headSha: "d".repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: [
        {
          id: "file-3",
          path: "src/index.ts",
          status: "added",
          additions: 5,
          deletions: 0,
          renderState: "renderable",
        },
      ],
    },
  ],
};

describe("useDiffFileNavigation", () => {
  it("flattens files across repositories in manifest order", () => {
    const { result } = renderHook(() =>
      useDiffFileNavigation({ manifest, selection: null, onSelect: vi.fn() })
    );

    expect(
      result.current.files.map(({ repository, file }) => [repository.position, file.path])
    ).toEqual([
      [0, "src/app.ts"],
      [0, "src/lib.ts"],
      [1, "src/index.ts"],
    ]);
    expect(result.current.selectedIndex).toBe(-1);
  });

  it("returns an empty list without a manifest", () => {
    const { result } = renderHook(() =>
      useDiffFileNavigation({ manifest: null, selection: null, onSelect: vi.fn() })
    );

    expect(result.current.files).toEqual([]);
    expect(result.current.selectedIndex).toBe(-1);
  });

  it("locates the selection by repository position and path", () => {
    const { result } = renderHook(() =>
      useDiffFileNavigation({
        manifest,
        selection: { repositoryPosition: 0, path: "src/lib.ts" },
        onSelect: vi.fn(),
      })
    );

    expect(result.current.selectedIndex).toBe(1);
  });

  it("moves the selection across the repository boundary", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useDiffFileNavigation({
        manifest,
        selection: { repositoryPosition: 0, path: "src/lib.ts" },
        onSelect,
      })
    );

    result.current.moveSelection(1);
    expect(onSelect).toHaveBeenCalledWith({ repositoryPosition: 1, path: "src/index.ts" });
    result.current.moveSelection(-1);
    expect(onSelect).toHaveBeenCalledWith({ repositoryPosition: 0, path: "src/app.ts" });
  });

  it("ignores moves past either end of the file list", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useDiffFileNavigation({
        manifest,
        selection: { repositoryPosition: 1, path: "src/index.ts" },
        onSelect,
      })
    );

    result.current.moveSelection(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
