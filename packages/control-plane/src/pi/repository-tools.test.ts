import { describe, expect, it, vi } from "vitest";
import { PiRepositoryTools } from "./repository-tools";

function harness() {
  const resolveCommit = vi.fn(async () => ({ sha: "abc123" }));
  const listTree = vi.fn(async () => ({
    entries: [
      {
        path: "src/index.ts",
        type: "file" as const,
        blobId: "blob-1",
        sizeBytes: 12,
        executable: false,
      },
    ],
    truncated: false,
  }));
  const readFile = vi.fn(async () => new TextEncoder().encode("hello world\n"));
  const tools = new PiRepositoryTools({
    repositories: () => [
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        baseBranch: "main",
      },
    ],
    resolveCredentialScope: vi.fn(async () => ({ kind: "all" as const })),
    provider: () => ({ resolveCommit, listTree, readFile }),
  });
  return { tools, resolveCommit, listTree, readFile };
}

describe("PiRepositoryTools", () => {
  it("pins each session repository to one immutable default commit", async () => {
    const h = harness();
    await expect(h.tools.pin()).resolves.toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        baseBranch: "main",
        commitSha: "abc123",
      },
    ]);
  });

  it("restores durable pins without resolving mutable branch heads", () => {
    const h = harness();
    expect(
      h.tools.restore([
        {
          repoOwner: "acme",
          repoName: "widgets",
          position: 0,
          commitSha: "original-sha",
        },
      ])
    ).toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        baseBranch: "main",
        commitSha: "original-sha",
      },
    ]);
    expect(h.resolveCommit).not.toHaveBeenCalled();
  });

  it("rejects restored pins for another repository set", () => {
    const h = harness();
    expect(() =>
      h.tools.restore([
        {
          repoOwner: "acme",
          repoName: "other",
          position: 0,
          commitSha: "original-sha",
        },
      ])
    ).toThrow("does not match");
  });

  it("lists a bounded repository tree at an immutable commit", async () => {
    const h = harness();

    await expect(h.tools.list({ repository: 0, path: "src" })).resolves.toEqual({
      repository: "acme/widgets",
      commitSha: "abc123",
      path: "src",
      truncated: false,
      nextOffset: null,
      entries: [
        {
          path: "src/index.ts",
          type: "file",
          sizeBytes: 12,
          executable: false,
        },
      ],
    });
    expect(h.listTree).toHaveBeenCalledWith(
      { owner: "acme", name: "widgets", commitSha: "abc123", path: "src" },
      { kind: "all" }
    );
  });

  it("reads UTF-8 text by blob id from the resolved commit", async () => {
    const h = harness();

    await expect(h.tools.read({ repository: 0, path: "src/index.ts" })).resolves.toEqual({
      repository: "acme/widgets",
      commitSha: "abc123",
      path: "src/index.ts",
      content: "hello world\n",
      start: 0,
      end: 12,
      totalBytes: 12,
      truncated: false,
    });
    expect(h.readFile).toHaveBeenCalledWith(
      {
        owner: "acme",
        name: "widgets",
        commitSha: "abc123",
        path: "src/index.ts",
        maxBytes: 262_144,
      },
      { kind: "all" }
    );
    expect(h.listTree).not.toHaveBeenCalled();
  });

  it.each(["/etc/passwd", "../secret", "src/../../secret", "src\\index.ts"])(
    "rejects unsafe repository paths: %s",
    async (path) => {
      const h = harness();
      await expect(h.tools.read({ path })).rejects.toThrow("repository-relative POSIX path");
      expect(h.resolveCommit).not.toHaveBeenCalled();
    }
  );

  it("rejects a repository outside the session member list", async () => {
    const h = harness();
    await expect(h.tools.list({ repository: 1 })).rejects.toThrow(
      "Repository index 1 is not part of this session"
    );
  });

  it("pages large trees instead of returning an unbounded structured result", async () => {
    const h = harness();
    h.listTree.mockResolvedValueOnce({
      entries: Array.from({ length: 3 }, (_, index) => ({
        path: `file-${index}.txt`,
        type: "file" as const,
        blobId: `blob-${index}`,
        sizeBytes: 1,
        executable: false,
      })),
      truncated: false,
    });
    await expect(h.tools.list({ offset: 1, limit: 1 })).resolves.toMatchObject({
      entries: [expect.objectContaining({ path: "file-1.txt" })],
      truncated: true,
      nextOffset: 2,
    });
  });

  it("refuses truncated provider trees instead of presenting an incomplete listing", async () => {
    const h = harness();
    h.listTree.mockResolvedValueOnce({ entries: [], truncated: true });
    await expect(h.tools.list({})).rejects.toThrow("repository tree is truncated");
  });

  it("rejects binary files", async () => {
    const h = harness();
    h.readFile.mockResolvedValueOnce(new Uint8Array([0, 1, 2]));
    await expect(h.tools.read({ path: "src/index.ts" })).rejects.toThrow("not UTF-8 text");
  });
});
