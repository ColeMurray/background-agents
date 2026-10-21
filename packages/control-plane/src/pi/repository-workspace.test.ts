import { describe, expect, it, vi } from "vitest";
import type { PiRepositoryMaterialization } from "./repository-materialization-contract";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
import { PiRepositoryWorkspace, type RepositoryWorkspaceFileSystem } from "./repository-workspace";
import { WorkspaceMutationFifo } from "../pi/computer-workspace-quota";

const SHA = "a".repeat(40);

class MemoryFileSystem implements RepositoryWorkspaceFileSystem {
  readonly files = new Map<string, { bytes: Uint8Array; mode: number }>();
  readonly directories = new Set<string>(["/", "/workspace", "/workspace/repos"]);

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
    if (this.files.delete(path)) return;
    if (this.directories.has(path)) {
      const prefix = `${path}/`;
      const nonEmpty =
        [...this.files.keys()].some((candidate) => candidate.startsWith(prefix)) ||
        [...this.directories].some(
          (candidate) => candidate !== path && candidate.startsWith(prefix)
        );
      if (nonEmpty) throw new Error(`ENOTEMPTY: ${path}`);
      this.directories.delete(path);
      return;
    }
    if (!options?.force) throw new Error(`ENOENT: ${path}`);
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

  lstat(path: string) {
    return this.stat(path);
  }

  async readdir(path: string, options?: { limit?: number; offset?: number }) {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Map<
      string,
      { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; size: number }
    >();
    for (const [candidate, file] of this.files) {
      if (!candidate.startsWith(prefix)) continue;
      const relative = candidate.slice(prefix.length);
      if (relative.includes("/")) continue;
      names.set(relative, {
        name: relative,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: file.bytes.byteLength,
      });
    }
    for (const candidate of this.directories) {
      if (!candidate.startsWith(prefix) || candidate === path) continue;
      const relative = candidate.slice(prefix.length);
      if (!relative || relative.includes("/")) continue;
      names.set(relative, {
        name: relative,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        size: 0,
      });
    }
    const entries = [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
    const offset = options?.offset ?? 0;
    return entries.slice(offset, offset + (options?.limit ?? entries.length));
  }
}

class FailingStatFileSystem extends MemoryFileSystem {
  override async stat(path: string) {
    if (path.endsWith("manifest.json")) throw new Error("database unavailable");
    return super.stat(path);
  }
}

function materialization(position = 0, repoName = "widgets"): PiRepositoryMaterialization {
  const blobIds: Record<string, string> = {
    "src/app.ts": "8cedce9e8ef473050c0398c1020954536a602ee9",
    "delete.txt": "10b961ad963604811a8842ba7da40feb9c077580",
    "binary.dat": "8352675d67aed6625ece79af41c27fdb4ee2e867",
  };
  const file = (path: string, content: Uint8Array, mode: "100644" | "100755" = "100644") => ({
    path,
    blobId: blobIds[path] ?? `blob-${path}`,
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

async function downgradeManifestToV1(fs: MemoryFileSystem, position = 0): Promise<void> {
  const path = `/.open-inspect/repositories/${position}/manifest.json`;
  const manifest = JSON.parse(await fs.readFile(path, "utf8")) as {
    version: number;
    files: Array<Record<string, unknown>>;
  };
  await fs.writeFile(
    path,
    JSON.stringify({
      ...manifest,
      version: 1,
      files: manifest.files.map(({ contentSha256: _hash, ...file }) => file),
    })
  );
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
    await expect(
      fs.readFile("/.open-inspect/repositories/0/manifest.json", "utf8")
    ).resolves.toContain('"version":2');
    await expect(
      fs.readFile("/.open-inspect/repositories/0/manifest.json", "utf8")
    ).resolves.toMatch(/"contentSha256":"[0-9a-f]{64}"/);
    expect([...fs.files.keys()].some((path) => path.startsWith("/.open-inspect/staging/"))).toBe(
      false
    );
  });

  it("restores a complete durable overlay without source materialization", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          commitSha: SHA,
        },
      ])
    ).resolves.toEqual({ materializePositions: [] });
    await expect(restored.captureDiff(null)).resolves.toMatchObject({
      repositories: [expect.objectContaining({ position: 0, files: [] })],
    });
  });

  it("atomically migrates a complete v1 manifest without provider access", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    await downgradeManifestToV1(fs);
    const path = "/.open-inspect/repositories/0/manifest.json";
    const unordered = JSON.parse(await fs.readFile(path, "utf8")) as {
      files: Array<Record<string, unknown> & { path: string }>;
    };
    const files = [...unordered.files].reverse().map((file) =>
      file.path === "src/app.ts"
        ? {
            ...file,
            blobId: "c64a20986d6f43008fc8a6179c8e5d39906add429ac94948186ef9d0b8085a15",
          }
        : file
    );
    await fs.writeFile(path, JSON.stringify({ ...unordered, files }));
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([{ position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA }])
    ).resolves.toEqual({ materializePositions: [] });
    const migrated = await fs.readFile(path, "utf8");
    expect(migrated).toContain('"version":2');
    expect(migrated).toMatch(/"contentSha256":"[0-9a-f]{64}"/);
    const migratedPaths = (JSON.parse(migrated) as { files: Array<{ path: string }> }).files.map(
      (file) => file.path
    );
    expect(migratedPaths).toEqual([...migratedPaths].sort());
    expect([...fs.files.keys()].some((path) => path.includes("manifest.migrating"))).toBe(false);
  });

  it("migrates v1 while preserving edits, additions, and deletions across eviction", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await computerWrite(first, fs, "/workspace/repos/0/src/app.ts", "const value = 2;\n");
    await computerWrite(first, fs, "/workspace/repos/0/added.txt", "added\n");
    await computerDelete(first, fs, "/workspace/repos/0/delete.txt");
    await downgradeManifestToV1(fs);

    const restored = new PiRepositoryWorkspace(fs, () => 200);
    await expect(
      restored.restore([{ position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA }])
    ).resolves.toEqual({ materializePositions: [] });
    await expect(restored.captureDiff(null)).resolves.toMatchObject({
      repositories: [
        expect.objectContaining({
          files: [
            expect.objectContaining({ path: "added.txt", status: "added" }),
            expect.objectContaining({ path: "delete.txt", status: "deleted" }),
            expect.objectContaining({ path: "src/app.ts", status: "modified" }),
          ],
        }),
      ],
    });
    expect(fs.files.has("/workspace/repos/0/delete.txt")).toBe(false);
    await expect(fs.readFile("/workspace/repos/0/added.txt", "utf8")).resolves.toBe("added\n");
  });

  it("recovers a v1 pending manifest after the repository root was installed", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    await downgradeManifestToV1(fs);
    await fs.rename(
      "/.open-inspect/repositories/0/manifest.json",
      "/.open-inspect/repositories/0/manifest.pending.json"
    );

    await expect(
      new PiRepositoryWorkspace(fs, () => 200).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).resolves.toEqual({ materializePositions: [] });

    await expect(
      fs.readFile("/.open-inspect/repositories/0/manifest.json", "utf8")
    ).resolves.toContain('"version":2');
    expect(fs.files.has("/.open-inspect/repositories/0/manifest.pending.json")).toBe(false);
  });

  it("requires provider repair instead of blessing same-size v1 source corruption", async () => {
    const fs = new MemoryFileSystem();
    const source = materialization();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([source]);
    await downgradeManifestToV1(fs);
    await fs.writeFile("/workspace/repos/0/src/app.ts", "const value = 9;\n", { mode: 0o100644 });
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([{ position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA }])
    ).resolves.toMatchObject({ materializePositions: [0] });
    await restored.materialize([source]);
    await expect(fs.readFile("/workspace/repos/0/src/app.ts", "utf8")).resolves.toBe(
      "const value = 1;\n"
    );
  });

  it("fails closed on unattached or non-numeric top-level repository roots", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    await fs.mkdir("/workspace/repos/9", { recursive: true });
    await fs.writeFile("/workspace/repos/9/private.txt", "private\n");

    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/unattached top-level root/);
  });

  it("cleans stale staging before aggregate restore validation", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    await fs.mkdir("/.open-inspect/staging/repository-99", { recursive: true });
    await fs.writeFile("/.open-inspect/staging/repository-99/stale.bin", new Uint8Array(10_000));

    await expect(
      new PiRepositoryWorkspace(fs, () => 200, { maxTotalBytes: 2_000 }).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).resolves.toMatchObject({ materializePositions: [] });
    expect([...fs.files.keys()].some((path) => path.startsWith("/.open-inspect/staging/"))).toBe(
      false
    );
  });

  it("reserves temporary migration bytes before v1 and v2 manifests coexist", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    const manifestPath = "/.open-inspect/repositories/0/manifest.json";
    const v2Bytes = fs.files.get(manifestPath)?.bytes.byteLength ?? 0;
    await downgradeManifestToV1(fs);
    const v1Bytes = fs.files.get(manifestPath)?.bytes.byteLength ?? 0;
    const currentBytes = [...fs.files.entries()]
      .filter(
        ([path]) => path.startsWith("/workspace/repos/") || path.startsWith("/.open-inspect/")
      )
      .reduce((sum, [, file]) => sum + file.bytes.byteLength, 0);
    const finalBytes = currentBytes - v1Bytes + v2Bytes;

    await expect(
      new PiRepositoryWorkspace(fs, () => 200, { maxTotalBytes: finalBytes }).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/total byte limit/);
    expect([...fs.files.keys()].some((path) => path.includes("manifest.migrating"))).toBe(false);
  });

  it("removes an interrupted manifest migration before exact-boundary quota preflight", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    const manifestPath = "/.open-inspect/repositories/0/manifest.json";
    const migratingPath = "/.open-inspect/repositories/0/manifest.migrating.json";
    const v2 = await fs.readFile(manifestPath, "utf8");
    const v2Bytes = new TextEncoder().encode(v2).byteLength;
    await downgradeManifestToV1(fs);
    const currentBytes = [...fs.files.entries()]
      .filter(
        ([path]) => path.startsWith("/workspace/repos/") || path.startsWith("/.open-inspect/")
      )
      .reduce((sum, [, file]) => sum + file.bytes.byteLength, 0);
    await fs.writeFile(migratingPath, v2);

    await expect(
      new PiRepositoryWorkspace(fs, () => 200, {
        maxTotalBytes: currentBytes + v2Bytes,
      }).restore([{ position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA }])
    ).resolves.toEqual({ materializePositions: [] });
    expect(fs.files.has(migratingPath)).toBe(false);
    await expect(fs.readFile(manifestPath, "utf8")).resolves.toContain('"version":2');
  });

  it("fails closed instead of repairing an unexplained missing source file", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await fs.rm("/workspace/repos/0/src/app.ts");
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          commitSha: SHA,
        },
      ])
    ).rejects.toThrow(/unchanged file is missing/);
    expect(fs.files.has("/workspace/repos/0/src/app.ts")).toBe(false);
  });

  it("counts complete overlays while requesting only incomplete repository positions", async () => {
    const fs = new MemoryFileSystem();
    const firstSource = materialization();
    const secondSource: PiRepositoryMaterialization = {
      ...materialization(),
      repository: {
        ...materialization().repository,
        position: 1,
        repoName: "second",
        root: "/workspace/repos/1",
      },
    };
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([firstSource, secondSource]);
    await fs.rm("/workspace/repos/1", { recursive: true });
    await fs.rm("/.open-inspect/repositories/1/manifest.json");
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          commitSha: SHA,
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "second",
          commitSha: SHA,
        },
      ])
    ).resolves.toEqual({ materializePositions: [1] });
  });

  it("rejects a durable manifest set above the configured live-file limit", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    const restored = new PiRepositoryWorkspace(fs, () => 200, { maxLiveFiles: 2 });

    await expect(
      restored.restore([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          commitSha: SHA,
        },
      ])
    ).rejects.toThrow("live file limit");
  });

  it("enforces aggregate live bytes across repositories and reclaims deletion capacity", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100, { maxLiveBytes: 70 });
    await workspace.materialize([materialization(0, "one"), materialization(1, "two")]);

    await expect(
      computerWrite(workspace, fs, "/workspace/repos/0/large.txt", "x".repeat(20))
    ).rejects.toThrow(/live byte limit/);
    await computerDelete(workspace, fs, "/workspace/repos/1/delete.txt");
    await expect(
      computerWrite(workspace, fs, "/workspace/repos/0/large.txt", "x".repeat(10))
    ).resolves.toBeUndefined();
  });

  it("counts durable additions in the restored live-file quota", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await computerWrite(first, fs, "/workspace/repos/0/added.txt", "added\n");

    await expect(
      new PiRepositoryWorkspace(fs, () => 200, { maxLiveFiles: 3 }).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/live file limit/);
  });

  it("rejects an encoded v2 manifest above the metadata reader limit before materialization", async () => {
    const fs = new MemoryFileSystem();
    const source = materialization();
    source.files = Array.from({ length: 1_000 }, (_, index) => {
      const prefix = `${String(index).padStart(4, "0")}-`;
      return {
        path: `${prefix}${"a".repeat(4_096 - prefix.length)}`,
        blobId: `blob-${index}`,
        mode: "100644" as const,
        sizeBytes: 0,
        contentBase64: "",
      };
    });
    const workspace = new PiRepositoryWorkspace(fs, () => 100);

    await expect(workspace.materialize([source])).rejects.toThrow(/manifest.*metadata limit/i);
    expect([...fs.files.keys()].some((path) => path.startsWith("/workspace/repos/0"))).toBe(false);
  });

  it("counts directories and hidden metadata in the session entry limit", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100, { maxEntries: 4 });

    await expect(workspace.materialize([materialization()])).rejects.toThrow(/total entry limit/);

    expect([...fs.files.keys()].some((path) => path.startsWith("/workspace/repos/0"))).toBe(false);
    expect(
      [...fs.files.keys()].some((path) => path.startsWith("/.open-inspect/repositories/0"))
    ).toBe(false);
  });

  it("fails closed when unchanged repository bytes or modes do not match the durable manifest", async () => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    await fs.writeFile("/workspace/repos/0/src/app.ts", "const value = 9;\n", { mode: 0o100644 });
    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/hash/);

    await fs.writeFile("/workspace/repos/0/src/app.ts", "const value = 1;\n", { mode: 0o100755 });
    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/mode/);
  });

  it.each([
    {
      files: [
        {
          path: "../escape",
          blobId: "x",
          mode: "100644",
          sizeBytes: 1,
          contentSha256: "a".repeat(64),
        },
      ],
    },
    {
      files: [
        { path: "a", blobId: "x", mode: "100644", sizeBytes: 1, contentSha256: "not-a-hash" },
      ],
    },
  ])("fails closed on corrupt durable manifest variant %#", async (change) => {
    const fs = new MemoryFileSystem();
    await new PiRepositoryWorkspace(fs, () => 100).materialize([materialization()]);
    const path = "/.open-inspect/repositories/0/manifest.json";
    const manifest = JSON.parse(await fs.readFile(path, "utf8"));
    await fs.writeFile(path, JSON.stringify({ ...manifest, ...change }));

    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow();
  });

  it("rejects unexplained extra files while restoring changed additions", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await fs.writeFile("/workspace/repos/0/untracked.txt", "surprise\n");

    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/unexplained/);

    await computerWrite(first, fs, "/workspace/repos/0/added.txt", "explained\n");
    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/unexplained/);
    await fs.rm("/workspace/repos/0/untracked.txt");
    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).resolves.toMatchObject({ materializePositions: [] });
  });

  it("treats a durably recorded tracked-file deletion as a complete overlay", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await computerDelete(first, fs, "/workspace/repos/0/delete.txt");
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          commitSha: SHA,
        },
      ])
    ).resolves.toEqual({ materializePositions: [] });
    expect(fs.files.has("/workspace/repos/0/delete.txt")).toBe(false);
  });

  it("repairs a missing mutation baseline without restoring a recorded deletion", async () => {
    const fs = new MemoryFileSystem();
    const source = materialization();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([source]);
    await computerDelete(first, fs, "/workspace/repos/0/delete.txt");
    await fs.rm("/.open-inspect/repositories/0/baseline/delete.txt");
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "widgets",
          commitSha: SHA,
        },
      ])
    ).resolves.toEqual({ materializePositions: [0] });
    await restored.materialize([source]);
    expect(fs.files.has("/workspace/repos/0/delete.txt")).toBe(false);
    await expect(restored.captureDiff(null)).resolves.toMatchObject({
      repositories: [
        expect.objectContaining({
          files: [expect.objectContaining({ path: "delete.txt", status: "deleted" })],
        }),
      ],
    });
  });

  it("still detects unexplained files when another path needs baseline repair", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await computerWrite(first, fs, "/workspace/repos/0/src/app.ts", "const value = 2;\n");
    await fs.rm("/.open-inspect/repositories/0/baseline/src/app.ts");
    await fs.writeFile("/workspace/repos/0/unexplained.txt", "surprise\n");

    await expect(
      new PiRepositoryWorkspace(fs).restore([
        { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
      ])
    ).rejects.toThrow(/unexplained/);
  });

  it("reruns canonical validation after repairing a missing baseline", async () => {
    const fs = new MemoryFileSystem();
    const source = materialization();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([source]);
    await computerWrite(first, fs, "/workspace/repos/0/src/app.ts", "const value = 2;\n");
    await fs.rm("/.open-inspect/repositories/0/baseline/src/app.ts");
    const restored = new PiRepositoryWorkspace(fs, () => 200);
    await expect(
      restored.restore([{ position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA }])
    ).resolves.toMatchObject({ materializePositions: [0] });
    await fs.writeFile("/workspace/repos/0/unexplained.txt", "surprise\n");

    await expect(restored.materialize([source])).rejects.toThrow(/unexplained/);
  });

  it("refuses to rebuild a missing repository root over durable changes", async () => {
    const fs = new MemoryFileSystem();
    const source = materialization();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([source]);
    await computerDelete(first, fs, "/workspace/repos/0/delete.txt");
    await fs.rm("/workspace/repos/0", { recursive: true });
    const restored = new PiRepositoryWorkspace(fs, () => 200);

    await expect(
      restored.restore([{ position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA }])
    ).resolves.toMatchObject({ materializePositions: [0] });
    await expect(restored.materialize([source])).rejects.toThrow(/without undoing durable changes/);
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

  it("rejects overlong paths before executing a mutation", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);
    await workspace.materialize([materialization()]);
    const execute = vi.fn(async () => {});

    await expect(
      workspace.runMutation(
        "write",
        { path: `/workspace/repos/0/${"a".repeat(4_097)}`, content: "no" },
        execute,
        async () => {},
        async () => null
      )
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds total live repository files after additions", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100, { maxLiveFiles: 3 });
    await workspace.materialize([materialization()]);

    await expect(
      computerWrite(workspace, fs, "/workspace/repos/0/fourth.txt", "fourth\n")
    ).rejects.toThrow("live file limit");
    expect(fs.files.has("/workspace/repos/0/fourth.txt")).toBe(false);
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
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: "first", mutation: "applied", projection: "published" },
      { value: "second", mutation: "applied", projection: "published" },
    ]);
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

  it("returns applied with projection pending after durable staging when publication is down", async () => {
    const fs = new MemoryFileSystem();
    const staged: SessionDiffUpload[] = [];
    const order: string[] = [];
    const schedule = vi.fn(async () => {
      order.push("schedule");
    });
    const workspace = new PiRepositoryWorkspace(fs, () => 100, {
      publication: {
        async stage(bundle) {
          order.push("stage");
          staged.push(bundle);
        },
        drain: vi.fn(async () => {
          order.push("publish");
          return "pending" as const;
        }),
        recordCaptureFailure: vi.fn(async () => undefined),
        recordFailure: vi.fn(async () => undefined),
        reportFailure: vi.fn(async () => undefined),
        schedule,
      },
    });
    await workspace.materialize([materialization()]);

    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/applied.txt", content: "applied\n" },
        async () => {
          await fs.writeFile("/workspace/repos/0/applied.txt", "applied\n");
          return { content: [], isError: false };
        },
        async () => {
          throw new Error("must use outbox");
        },
        async () => "message-1"
      )
    ).resolves.toMatchObject({ mutation: "applied", projection: "pending" });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.triggerMessageId).toBe("message-1");
    expect(schedule).toHaveBeenCalledOnce();
    expect(order).toEqual(["stage", "schedule"]);
  });

  it("does not claim durable retry when scheduling and immediate publication both fail", async () => {
    const fs = new MemoryFileSystem();
    const recordFailure = vi.fn(async () => undefined);
    const schedule = vi.fn(async () => Promise.reject(new Error("job queue unavailable")));
    const workspace = new PiRepositoryWorkspace(fs, () => 100, {
      publication: {
        stage: vi.fn(async () => undefined),
        drain: vi.fn(async () => "pending" as const),
        recordCaptureFailure: vi.fn(async () => undefined),
        recordFailure,
        reportFailure: vi.fn(async () => undefined),
        schedule,
      },
    });
    await workspace.materialize([materialization()]);

    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/applied.txt", content: "applied\n" },
        async () => {
          await fs.writeFile("/workspace/repos/0/applied.txt", "applied\n");
          return { content: [], isError: false };
        },
        async () => undefined,
        async () => "message-1"
      )
    ).resolves.toMatchObject({ mutation: "applied", projection: "failed" });
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "job queue unavailable" })
    );
  });

  it("reports applied but unprojected when durable stage fails", async () => {
    const fs = new MemoryFileSystem();
    const recordCaptureFailure = vi.fn(async () => undefined);
    const workspace = new PiRepositoryWorkspace(fs, () => 100, {
      publication: {
        stage: vi.fn(async () => Promise.reject(new Error("sqlite unavailable"))),
        drain: vi.fn(async () => "idle" as const),
        recordCaptureFailure,
        recordFailure: vi.fn(async () => undefined),
        reportFailure: vi.fn(async () => undefined),
        schedule: vi.fn(async () => undefined),
      },
    });
    await workspace.materialize([materialization()]);

    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/applied.txt", content: "applied\n" },
        async () => {
          await fs.writeFile("/workspace/repos/0/applied.txt", "applied\n");
          return { content: [], isError: false };
        },
        async () => undefined,
        async () => "message-1"
      )
    ).resolves.toMatchObject({ mutation: "applied", projection: "failed" });
    expect(recordCaptureFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sqlite unavailable" })
    );
  });

  it("does not consume hidden baseline quota when Computer reports a failed write", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);
    await workspace.materialize([materialization()]);

    await expect(
      workspace.runMutation(
        "write",
        { path: "/workspace/repos/0/src/app.ts", content: "replacement\n" },
        async () => ({ content: [{ type: "text", text: "write failed" }], isError: true }),
        async () => undefined,
        async () => null
      )
    ).resolves.toMatchObject({ mutation: "failed" });

    expect(fs.files.has("/.open-inspect/repositories/0/baseline/src/app.ts")).toBe(false);
    await expect(workspace.captureDiff(null)).resolves.toMatchObject({
      repositories: [expect.objectContaining({ files: [] })],
    });
  });

  it("reclaims baselines, empty baseline directories, and changes metadata for no-ops", async () => {
    const fs = new MemoryFileSystem();
    const workspace = new PiRepositoryWorkspace(fs, () => 100);
    await workspace.materialize([materialization()]);
    const path = "/workspace/repos/0/src/app.ts";

    await workspace.runMutation(
      "write",
      { path, content: "const value = 1;\n" },
      async () => {
        await fs.writeFile(path, "const value = 1;\n");
        return { content: [], isError: false };
      },
      async () => undefined,
      async () => null
    );
    for (const tool of ["edit", "delete"] as const) {
      await workspace.runMutation(
        tool,
        tool === "edit" ? { path, edits: [{ oldText: "missing", newText: "nope" }] } : { path },
        async () => ({ content: [], isError: true }),
        async () => undefined,
        async () => null
      );
    }

    expect([...fs.files.keys()].filter((candidate) => candidate.includes("/baseline/"))).toEqual(
      []
    );
    expect(fs.directories.has("/.open-inspect/repositories/0/baseline/src")).toBe(false);
    expect(fs.files.has("/.open-inspect/repositories/0/changes.json")).toBe(false);
  });

  it("charges only the changes metadata delta when mutating an already-changed path", async () => {
    const fs = new MemoryFileSystem();
    const first = new PiRepositoryWorkspace(fs, () => 100);
    await first.materialize([materialization()]);
    await computerWrite(first, fs, "/workspace/repos/0/src/app.ts", "const value = 2;\n");
    const totalBytes = [...fs.files.entries()]
      .filter(
        ([path]) => path.startsWith("/workspace/repos/") || path.startsWith("/.open-inspect/")
      )
      .reduce((sum, [, file]) => sum + file.bytes.byteLength, 0);
    const restored = new PiRepositoryWorkspace(fs, () => 200, { maxTotalBytes: totalBytes });
    await restored.restore([
      { position: 0, repoOwner: "acme", repoName: "widgets", commitSha: SHA },
    ]);

    await expect(
      computerWrite(restored, fs, "/workspace/repos/0/src/app.ts", "const value = 3;\n")
    ).resolves.toBeUndefined();
  });
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
