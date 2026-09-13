import { describe, expect, it } from "vitest";
import type {
  SessionDiffFile,
  SessionDiffManifest,
  SessionDiffRepository,
} from "@open-inspect/shared/types/session-diffs";
import { isRepositoryFileHref, resolveDiffFileLink } from "./diff-file-links";

function file(path: string, extra: Partial<SessionDiffFile> = {}): SessionDiffFile {
  return {
    id: `id-${path}`,
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    renderState: "renderable",
    ...extra,
  };
}

function repository(
  position: number,
  repoName: string,
  files: SessionDiffFile[]
): SessionDiffRepository {
  return {
    status: "ready",
    position,
    repoOwner: "acme",
    repoName,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    truncated: false,
    omittedFileCount: 0,
    files,
  };
}

function manifest(...repositories: SessionDiffRepository[]): SessionDiffManifest {
  return {
    version: 1,
    revisionId: "revision-1",
    capturedAt: 100,
    triggerMessageId: null,
    repositories,
  };
}

const single = manifest(
  repository(0, "web", [
    file("docs/plans/daytona-prebuild-parity.md"),
    file("src/new-name.ts", { status: "renamed", oldPath: "src/old-name.ts" }),
    file("docs/with space.md"),
  ])
);

describe("isRepositoryFileHref", () => {
  it.each(["docs/plans/x.md", "./docs/plans/x.md", "../x.md", "/workspace/web/src/index.ts"])(
    "treats %s as a repository file",
    (href) => {
      expect(isRepositoryFileHref(href)).toBe(true);
    }
  );

  it.each([
    undefined,
    "",
    "https://github.com/acme/web/blob/main/README.md",
    "http://example.com",
    "mailto:someone@example.com",
    "//cdn.example.com/x.js",
    "#section",
    "/settings",
  ])("leaves %s alone", (href) => {
    expect(isRepositoryFileHref(href)).toBe(false);
  });
});

describe("resolveDiffFileLink", () => {
  it("resolves a relative path to the changed file", () => {
    expect(resolveDiffFileLink(single, "docs/plans/daytona-prebuild-parity.md")).toEqual({
      repositoryPosition: 0,
      path: "docs/plans/daytona-prebuild-parity.md",
    });
  });

  it("normalizes ./, query, hash, percent-escapes and a trailing line reference", () => {
    const expected = { repositoryPosition: 0, path: "docs/plans/daytona-prebuild-parity.md" };
    expect(resolveDiffFileLink(single, "./docs/plans/daytona-prebuild-parity.md")).toEqual(
      expected
    );
    expect(resolveDiffFileLink(single, "docs/plans/daytona-prebuild-parity.md?plain=1#L3")).toEqual(
      expected
    );
    expect(resolveDiffFileLink(single, "docs/plans/daytona-prebuild-parity.md:42")).toEqual(
      expected
    );
    expect(resolveDiffFileLink(single, "docs/with%20space.md")).toEqual({
      repositoryPosition: 0,
      path: "docs/with space.md",
    });
  });

  it("resolves a renamed file by its old path to the new path", () => {
    expect(resolveDiffFileLink(single, "src/old-name.ts")).toEqual({
      repositoryPosition: 0,
      path: "src/new-name.ts",
    });
  });

  it("compares paths case-sensitively", () => {
    expect(resolveDiffFileLink(single, "DOCS/plans/daytona-prebuild-parity.md")).toBeNull();
  });

  it("resolves /workspace/<repoName>/<path>, matching repoName case-insensitively", () => {
    const multi = manifest(
      repository(0, "web", [file("README.md")]),
      repository(1, "API", [file("README.md")])
    );
    expect(resolveDiffFileLink(multi, "/workspace/api/README.md")).toEqual({
      repositoryPosition: 1,
      path: "README.md",
    });
    expect(resolveDiffFileLink(multi, "/workspace/unknown/README.md")).toBeNull();
    expect(resolveDiffFileLink(multi, "/workspace/web")).toBeNull();
  });

  it("resolves a relative path found in several repositories to the lowest position", () => {
    const collision = manifest(
      repository(1, "api", [file("README.md")]),
      repository(0, "web", [file("README.md")])
    );
    expect(resolveDiffFileLink(collision, "README.md")).toEqual({
      repositoryPosition: 0,
      path: "README.md",
    });
  });

  it("skips repositories whose diff is unavailable", () => {
    const partial = manifest(
      {
        status: "unavailable",
        position: 0,
        repoOwner: "acme",
        repoName: "web",
        baseSha: "a".repeat(40),
        error: "x",
        files: [],
      },
      repository(1, "api", [file("README.md")])
    );
    expect(resolveDiffFileLink(partial, "README.md")).toEqual({
      repositoryPosition: 1,
      path: "README.md",
    });
  });

  it("returns null for files not in the diff, non-file hrefs and malformed escapes", () => {
    expect(resolveDiffFileLink(single, "src/untouched.ts")).toBeNull();
    expect(resolveDiffFileLink(single, "https://example.com/docs/with%20space.md")).toBeNull();
    expect(resolveDiffFileLink(single, "#docs")).toBeNull();
    expect(resolveDiffFileLink(single, "docs/%E0%A4%A.md")).toBeNull();
  });
});
