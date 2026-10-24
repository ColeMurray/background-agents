import { describe, expect, it, vi } from "vitest";
import { PiRepositoryTools } from "./repository-tools";

const FULL_SHA = "a".repeat(40);

function harness() {
  const resolveCommit = vi.fn(async () => ({ sha: FULL_SHA }));
  const listTree = vi.fn(async () => ({
    entries: [
      {
        path: "src/index.ts",
        type: "file" as "file" | "directory" | "other",
        blobId: "blob-1",
        mode: "100644",
        sizeBytes: 12 as number | null,
        executable: false,
      },
    ],
    truncated: false,
  }));
  const readFile = vi.fn(async () => new TextEncoder().encode("hello world\n"));
  const readBlob = vi.fn(async () => new TextEncoder().encode("hello world\n"));
  const observeMaterialization = vi.fn();
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
    provider: () => ({ resolveCommit, listTree, readFile, readBlob }),
    observeMaterialization,
  });
  return { tools, resolveCommit, listTree, readFile, readBlob, observeMaterialization };
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
        commitSha: FULL_SHA,
      },
    ]);
  });

  it("rejects abbreviated provider pins instead of persisting a mutable-looking ref", async () => {
    const h = harness();
    h.resolveCommit.mockResolvedValueOnce({ sha: "abc123" });

    await expect(h.tools.pin()).rejects.toThrow("full Git object SHA");
  });

  it("restores durable pins without resolving mutable branch heads", () => {
    const h = harness();
    expect(
      h.tools.restore([
        {
          repoOwner: "acme",
          repoName: "widgets",
          position: 0,
          commitSha: FULL_SHA,
        },
      ])
    ).toEqual([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        baseBranch: "main",
        commitSha: FULL_SHA,
      },
    ]);
    expect(h.resolveCommit).not.toHaveBeenCalled();
  });

  it("rejects abbreviated restored pins before repository access", () => {
    const h = harness();

    expect(() =>
      h.tools.restore([
        {
          repoOwner: "acme",
          repoName: "widgets",
          position: 0,
          commitSha: "abc123",
        },
      ])
    ).toThrow("full Git object SHA");
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
      commitSha: FULL_SHA,
      path: "src",
      truncated: false,
      nextOffset: null,
      entries: [
        {
          path: "src/index.ts",
          type: "file",
          mode: "100644",
          sizeBytes: 12,
          executable: false,
        },
      ],
    });
    expect(h.listTree).toHaveBeenCalledWith(
      { owner: "acme", name: "widgets", commitSha: FULL_SHA, path: "src" },
      { kind: "all" }
    );
  });

  it("reads UTF-8 text by blob id from the resolved commit", async () => {
    const h = harness();

    await expect(h.tools.read({ repository: 0, path: "src/index.ts" })).resolves.toEqual({
      repository: "acme/widgets",
      commitSha: FULL_SHA,
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
        commitSha: FULL_SHA,
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
        mode: "100644",
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

  it("prepares metadata and reads exact file bytes in bounded batches", async () => {
    const h = harness();

    await expect(
      h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA })
    ).resolves.toEqual({
      version: 1,
      repository: {
        position: 0,
        repoOwner: "acme",
        repoName: "widgets",
        commitSha: FULL_SHA,
        root: "/workspace/repos/0",
      },
      files: [
        {
          path: "src/index.ts",
          blobId: "blob-1",
          mode: "100644",
          sizeBytes: 12,
        },
      ],
    });
    expect(h.readBlob).not.toHaveBeenCalled();
    await expect(
      h.tools.materializeBatch({ repository: 0, commitSha: FULL_SHA, offset: 0 })
    ).resolves.toMatchObject({
      version: 1,
      offset: 0,
      nextOffset: null,
      files: [{ path: "src/index.ts", contentBase64: "aGVsbG8gd29ybGQK" }],
    });
    expect(h.readBlob).toHaveBeenCalledWith(
      { owner: "acme", name: "widgets", blobId: "blob-1", maxBytes: 262_144 },
      { kind: "all" }
    );
  });

  it("refuses unsupported Git modes before downloading any blob", async () => {
    const h = harness();
    h.listTree.mockResolvedValueOnce({
      entries: [
        {
          path: "link",
          type: "other",
          blobId: "link-blob",
          mode: "120000",
          sizeBytes: 6,
          executable: false,
        },
      ],
      truncated: false,
    });

    await expect(
      h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA })
    ).rejects.toThrow("unsupported Git mode");
    expect(h.readBlob).not.toHaveBeenCalled();
  });

  it("rejects UTF-8 path and depth bombs before materialization", async () => {
    for (const path of [
      `${"😀".repeat(2_000)}.txt`,
      `${Array.from({ length: 65 }, () => "deep").join("/")}/file.txt`,
    ]) {
      const h = harness();
      h.listTree.mockResolvedValueOnce({
        entries: [
          {
            path,
            type: "file",
            blobId: "blob-1",
            mode: "100644",
            sizeBytes: 1,
            executable: false,
          },
        ],
        truncated: false,
      });
      await expect(
        h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA })
      ).rejects.toThrow(/repository-relative POSIX path|Path must/);
      expect(h.readBlob).not.toHaveBeenCalled();
    }
  });

  it("refuses provider size mismatches instead of materializing an inexact tree", async () => {
    const h = harness();
    h.listTree.mockResolvedValueOnce({
      entries: [
        {
          path: "src/index.ts",
          type: "file",
          blobId: "blob-1",
          mode: "100644",
          sizeBytes: 99,
          executable: false,
        },
      ],
      truncated: false,
    });

    await h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA });
    await expect(
      h.tools.materializeBatch({ repository: 0, commitSha: FULL_SHA, offset: 0 })
    ).rejects.toThrow("size does not match");
  });

  it("refuses an oversized tree before downloading any blob", async () => {
    const h = harness();
    h.listTree.mockResolvedValueOnce({
      entries: Array.from({ length: 1_001 }, (_, index) => ({
        path: `directory-${index}`,
        type: "directory" as const,
        blobId: `tree-${index}`,
        mode: "040000",
        sizeBytes: null,
        executable: false,
      })),
      truncated: false,
    });

    await expect(
      h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA })
    ).rejects.toThrow("entry materialization limit");
    expect(h.readBlob).not.toHaveBeenCalled();
  });

  it("materializes 51 files without any request reading more than 40 blobs", async () => {
    const h = harness();
    const bytes = new TextEncoder().encode("x");
    h.listTree.mockResolvedValueOnce({
      entries: Array.from({ length: 51 }, (_, index) => ({
        path: `file-${index}.txt`,
        type: "file" as const,
        blobId: `blob-${index}`,
        mode: "100644",
        sizeBytes: 1,
        executable: false,
      })),
      truncated: false,
    });
    h.readBlob.mockResolvedValue(bytes);

    await h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA });
    const batches = await Promise.all(
      [0, 40].map((offset) =>
        h.tools.materializeBatch({ repository: 0, commitSha: FULL_SHA, offset })
      )
    );

    expect(batches.map((batch) => batch.files.length)).toEqual([40, 11]);
    expect(h.readBlob).toHaveBeenCalledTimes(51);
    expect(h.listTree).toHaveBeenCalledOnce();
  });

  it("coalesces immutable blob retries without caching credentials", async () => {
    const h = harness();
    await h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA });

    await Promise.all([
      h.tools.materializeBatch({ repository: 0, commitSha: FULL_SHA, offset: 0 }),
      h.tools.materializeBatch({ repository: 0, commitSha: FULL_SHA, offset: 0 }),
    ]);

    expect(h.readBlob).toHaveBeenCalledOnce();
    expect(h.observeMaterialization).toHaveBeenCalledWith(
      expect.objectContaining({ event: "blob_request", cacheHit: true, scopeKind: "all" })
    );
  });

  it("emits bounded request metrics for the 1000-blob worst case", async () => {
    const h = harness();
    h.listTree.mockResolvedValueOnce({
      entries: Array.from({ length: 1_000 }, (_, index) => ({
        path: `file-${index}.txt`,
        type: "file" as const,
        blobId: `blob-${index}`,
        mode: "100644",
        sizeBytes: 1,
        executable: false,
      })),
      truncated: false,
    });
    h.readBlob.mockResolvedValue(new Uint8Array([1]));
    await h.tools.prepareMaterialization({ repository: 0, commitSha: FULL_SHA });

    for (let offset = 0; offset < 1_000; offset += 40) {
      await h.tools.materializeBatch({ repository: 0, commitSha: FULL_SHA, offset });
    }

    expect(h.readBlob).toHaveBeenCalledTimes(1_000);
    expect(
      h.observeMaterialization.mock.calls.filter(
        ([event]) => event.event === "blob_request" && event.cacheHit === false
      )
    ).toHaveLength(1_000);
    expect(h.observeMaterialization).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "manifest_admission",
        repository: "acme/widgets",
        scopeKind: "all",
      })
    );
  });
});
