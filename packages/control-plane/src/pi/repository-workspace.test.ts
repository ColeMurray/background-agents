import { describe, expect, it, vi } from "vitest";
import type { PiRepositoryMaterialization } from "./repository-materialization-contract";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
import { PiRepositoryWorkspace, type RepositoryWorkspaceFileSystem } from "./repository-workspace";
import { WorkspaceMutationFifo } from "./computer-workspace-quota";

const SHA = "a".repeat(40);

class MemoryFileSystem implements RepositoryWorkspaceFileSystem {
  readonly files = new Map<string, { bytes: Uint8Array; mode: number }>();
  readonly directories = new Set<string>(["/"]);

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  async readFile(path: string, encoding?: "utf8"): Promise<string | ReadableStream<Uint8Array>> {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    if (encoding === "utf8") {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes);
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(file.bytes);
        controller.close();
      },
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { mode?: number }
  ): Promise<void> {
    this.files.set(path, {
      bytes: typeof content === "string" ? new TextEncoder().encode(content) : content,
      mode: options?.mode ?? this.files.get(path)?.mode ?? 0o100644,
    });
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        this.directories.add(current);
      }
      return;
    }
    this.directories.add(path);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (options?.recursive) {
      for (const candidate of [...this.files.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) this.files.delete(candidate);
      }
      for (const candidate of [...this.directories]) {
        if (candidate === path || candidate.startsWith(`${path}/`))
          this.directories.delete(candidate);
      }
      return;
    }
    if (!this.files.delete(path) && !options?.force) throw new Error(`ENOENT: ${path}`);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    for (const [path, file] of [...this.files]) {
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        this.files.delete(path);
        this.files.set(`${newPath}${path.slice(oldPath.length)}`, file);
      }
    }
    for (const path of [...this.directories]) {
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        this.directories.delete(path);
        this.directories.add(`${newPath}${path.slice(oldPath.length)}`);
      }
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    file.mode = mode;
  }

  async stat(path: string) {
    const file = this.files.get(path);
    if (file) {
      return {
        mode: file.mode,
        size: file.bytes.byteLength,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    }
    if (this.directories.has(path)) {
      return {
        mode: 0o40755,
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      };
    }
    throw new Error(`ENOENT: ${path}`);
  }
}

class FailingStatFileSystem extends MemoryFileSystem {
  override async stat(path: string) {
    if (path.endsWith("manifest.json")) throw new Error("database unavailable");
    return super.stat(path);
  }
}

function materialization(position = 0, repoName = "widgets"): PiRepositoryMaterialization {
  const file = (path: string, content: Uint8Array, mode: "100644" | "100755" = "100644") => ({
    path,
    blobId: `blob-${path}`,
    mode,
    sizeBytes: content.byteLength,
    contentBase64: bytesToBase64(content),
  });
  return {
    version: 1,
    repository: {
      position,
      repoOwner: "acme",
      repoName,
      commitSha: SHA,
      root: `/workspace/repos/${position}`,
    },
    files: [
      file("src/app.ts", new TextEncoder().encode("const value = 1;\n")),
      file("delete.txt", new TextEncoder().encode("remove me\n")),
      file("binary.dat", new Uint8Array([0, 1, 2])),
    ],
  };
}

async function computerWrite(
  workspace: PiRepositoryWorkspace,
  fs: MemoryFileSystem,
  path: string,
  content: string
): Promise<void> {
  await workspace.runMutation(
    "write",
    { path, content },
    async () => {
      await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(path, content);
    },
    async () => {},
    async () => null
  );
}

async function computerDelete(
  workspace: PiRepositoryWorkspace,
  fs: MemoryFileSystem,
  path: string
): Promise<void> {
  await workspace.runMutation(
    "delete",
    { path },
    () => fs.rm(path),
    async () => {},
    async () => null
  );
}

describe("PiRepositoryWorkspace", () => {
  it("stages an exact repository and keeps its manifest outside the model-visible root", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);

    await workspace.materialize([materialization()]);

    await expect(fs.readFile("/workspace/repos/0/src/app.ts", "utf8")).resolves.toBe(
      "const value = 1;\n"
    );
    expect([...fs.files.keys()]).toContain("/.open-inspect/repositories/0/manifest.json");
    expect([...fs.files.keys()].some((path) => path.startsWith("/.open-inspect/staging/"))).toBe(
      false
    );
  });

  it("captures tracked writes, additions, and deletions as one SessionDiff bundle", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);
    await workspace.materialize([materialization()]);

    await computerWrite(workspace, fs, "/workspace/repos/0/src/app.ts", "const value = 2;\n");
    await computerWrite(workspace, fs, "/workspace/repos/0/new.txt", "new file\n");
    await computerDelete(workspace, fs, "/workspace/repos/0/delete.txt");

    const bundle = await workspace.captureDiff("message-1");
    expect(bundle).toMatchObject({
      version: 1,
      triggerMessageId: "message-1",
      capturedAt: 100,
      repositories: [
        {
          status: "ready",
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          baseSha: SHA,
          headSha: SHA,
          truncated: false,
          omittedFileCount: 0,
          files: [
            expect.objectContaining({ path: "delete.txt", status: "deleted" }),
            expect.objectContaining({ path: "new.txt", status: "added" }),
            expect.objectContaining({ path: "src/app.ts", status: "modified" }),
          ],
        },
      ],
    });
    expect(JSON.stringify(bundle)).toContain("diff --git a/src/app.ts b/src/app.ts");
  });

  it("retains baseline overlays and changes across a workspace restart", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    const path = "/workspace/repos/0/src/app.ts";
    await first.runMutation(
      "edit",
      { path, edits: [{ oldText: "value = 1", newText: "value = 3" }] },
      () => fs.writeFile(path, "const value = 3;\n"),
      async () => {},
      async () => null
    );

    const restarted = new PiRepositoryWorkspace(fs, () => 200);
    await restarted.materialize([materialization()]);

    const bundle = await restarted.captureDiff(null);
    expect(bundle.capturedAt).toBe(200);
    expect(bundle.repositories[0]?.files).toEqual([
      expect.objectContaining({ path: "src/app.ts", status: "modified" }),
    ]);
  });

  it("rejects escapes, binary mutation, and recursive deletion before changing files", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);
    await workspace.materialize([materialization()]);

    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/../escape.txt", content: "no" },
        async () => {},
        async () => {},
        async () => null
      )
    ).rejects.toThrow("attached repository");
    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/binary.dat", content: "text" },
        async () => {},
        async () => {},
        async () => null
      )
    ).rejects.toThrow("UTF-8 text");
    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/new.txt", content: "not\0text" },
        async () => {},
        async () => {},
        async () => null
      )
    ).rejects.toThrow("UTF-8 text");
    await expect(
      workspace.runMutation(
        "delete",
        { path: "/workspace/repos/0/src", recursive: true },
        async () => {},
        async () => {},
        async () => null
      )
    ).rejects.toThrow("file deletion");
    expect(fs.files.has("/workspace/escape.txt")).toBe(false);
    expect(fs.files.has("/workspace/repos/0/new.txt")).toBe(false);
    expect(fs.files.get("/workspace/repos/0/binary.dat")?.bytes).toEqual(new Uint8Array([0, 1, 2]));
  });

  it("fails closed on VFS storage errors instead of treating metadata as absent", async () => {
    const fs = new FailingStatFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);

    await expect(workspace.materialize([materialization()])).rejects.toThrow(
      "database unavailable"
    );
    expect(fs.files.has("/workspace/repos/0/src/app.ts")).toBe(false);
  });

  it("enforces the changed-file limit across repositories and reuses reverted capacity", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100, { maxChangedFiles: 2 });
    await workspace.materialize([materialization(0, "one"), materialization(1, "two")]);
    await computerWrite(workspace, fs, "/workspace/repos/0/first.txt", "first\n");
    await computerWrite(workspace, fs, "/workspace/repos/0/second.txt", "second\n");

    await expect(
      computerWrite(workspace, fs, "/workspace/repos/1/third.txt", "third\n")
    ).rejects.toThrow("Too many changed repository files");
    expect(fs.files.has("/workspace/repos/1/third.txt")).toBe(false);

    await computerDelete(workspace, fs, "/workspace/repos/0/first.txt");
    await expect(
      computerWrite(workspace, fs, "/workspace/repos/1/third.txt", "third\n")
    ).resolves.toBeUndefined();
    const bundle = await workspace.captureDiff(null);
    expect(bundle.repositories.flatMap((repository) => repository.files)).toHaveLength(2);
  });

  it("keeps same-name repositories from different owners isolated by position", async () => {
    const fs = new MemoryFileSystem();
    const first = materialization(0, "shared");
    first.repository.repoOwner = "owner-one";
    const second = materialization(1, "shared");
    second.repository.repoOwner = "owner-two";
    const workspace = new PiRepositoryWorkspace(fs, () => 100);

    await workspace.materialize([first, second]);

    await expect(fs.readFile("/workspace/repos/0/src/app.ts", "utf8")).resolves.toContain("value");
    await expect(fs.readFile("/workspace/repos/1/src/app.ts", "utf8")).resolves.toContain("value");
  });

  it("holds one FIFO through Computer execution, reconciliation, assembly, and publication", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);
    await workspace.materialize([materialization()]);
    const order: string[] = [];
    const published: SessionDiffUpload[] = [];
    let releaseFirst!: () => void;
    let markFirstPublishStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstPublishStarted = new Promise<void>((resolve) => {
      markFirstPublishStarted = resolve;
    });

    const first = workspace.runMutation(
      "write",
      { path: "/workspace/repos/0/first.txt", content: "first\n" },
      async () => {
        order.push("execute:first");
        await fs.writeFile("/workspace/repos/0/first.txt", "first\n");
        return "first";
      },
      async (bundle) => {
        order.push("publish:first:start");
        published.push(bundle);
        markFirstPublishStarted();
        await firstGate;
        order.push("publish:first:end");
      },
      async () => "message-1"
    );
    const second = workspace.runMutation(
      "write",
      { path: "/workspace/repos/0/second.txt", content: "second\n" },
      async () => {
        order.push("execute:second");
        await fs.writeFile("/workspace/repos/0/second.txt", "second\n");
        return "second";
      },
      async (bundle) => {
        order.push("publish:second");
        published.push(bundle);
      },
      async () => "message-2"
    );
    await firstPublishStarted;
    expect(order).toEqual(["execute:first", "publish:first:start"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual([
      "execute:first",
      "publish:first:start",
      "publish:first:end",
      "execute:second",
      "publish:second",
    ]);
    expect(
      published
        .at(-1)
        ?.repositories.flatMap((repository) => repository.files.map((file) => file.path))
    ).toEqual(["first.txt", "second.txt"]);
  });

  it("shares the canonical workspace FIFO with scratch mutations", async () => {
    const fs = new MemoryFileSystem();
    const mutations = new WorkspaceMutationFifo();
    const workspace = new PiRepositoryWorkspace(fs, () => 100, { mutations });
    await workspace.materialize([materialization()]);
    let releaseScratch!: () => void;
    let markScratchStarted!: () => void;
    const scratchGate = new Promise<void>((resolve) => {
      releaseScratch = resolve;
    });
    const scratchStarted = new Promise<void>((resolve) => {
      markScratchStarted = resolve;
    });
    const scratch = mutations.run(async () => {
      markScratchStarted();
      await scratchGate;
    });
    const repositoryExecute = vi.fn(async () => {
      await fs.writeFile("/workspace/repos/0/from-repo.txt", "repo\n");
    });
    const repository = workspace.runMutation(
      "write",
      { path: "/workspace/repos/0/from-repo.txt", content: "repo\n" },
      repositoryExecute,
      async () => {},
      async () => null
    );

    await scratchStarted;
    expect(repositoryExecute).not.toHaveBeenCalled();
    releaseScratch();
    await Promise.all([scratch, repository]);
    expect(repositoryExecute).toHaveBeenCalledOnce();
  });
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
