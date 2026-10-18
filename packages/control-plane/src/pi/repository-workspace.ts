import { createTwoFilesPatch, diffLines } from "diff";
import {
  SESSION_DIFF_MAX_FILE_PATCH_BYTES,
  SESSION_DIFF_MAX_FILES,
  SESSION_DIFF_MAX_TOTAL_PATCH_BYTES,
  sessionDiffUploadSchema,
  type SessionDiffFileUpload,
  type SessionDiffUpload,
} from "@open-inspect/shared/types/session-diffs";
import { z } from "zod";
import {
  PI_REPOSITORY_MAX_FILE_BYTES,
  type PiRepositoryMaterialization,
} from "./session-context-contract";
import { FULL_GIT_OBJECT_ID_PATTERN } from "../source-control/git-object-id";
import { readBoundedBytes } from "../http/bounded-body";

const METADATA_ROOT = "/.open-inspect/repositories";
const STAGING_ROOT = "/.open-inspect/staging";
const MAX_TEXT_FILE_BYTES = PI_REPOSITORY_MAX_FILE_BYTES;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

interface RepositoryWorkspaceStat {
  mode: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface RepositoryWorkspaceFileSystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(path: string, content: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<RepositoryWorkspaceStat>;
}

interface StoredRepositoryManifest {
  version: 1;
  repository: PiRepositoryMaterialization["repository"];
  files: Array<{
    path: string;
    blobId: string;
    mode: "100644" | "100755";
    sizeBytes: number;
  }>;
}

const storedManifestSchema = z.object({
  version: z.literal(1),
  repository: z.object({
    position: z.number().int().nonnegative(),
    repoOwner: z.string().min(1),
    repoName: z.string().min(1),
    commitSha: z.string().regex(FULL_GIT_OBJECT_ID_PATTERN),
    root: z.string().min(1),
  }),
  files: z.array(
    z.object({
      path: z.string().min(1),
      blobId: z.string().min(1),
      mode: z.enum(["100644", "100755"]),
      sizeBytes: z.number().int().nonnegative(),
    })
  ),
});
const changedPathsSchema = z.array(z.string().min(1).max(4_096)).max(SESSION_DIFF_MAX_FILES);

export type RepositoryMutationName = "write" | "edit" | "delete";

export interface PreparedRepositoryMutation {
  readonly position: number;
  readonly path: string;
}

const repositoryMutationSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("write"),
    arguments: z.object({ path: z.string(), content: z.string() }),
  }),
  z.object({
    tool: z.literal("edit"),
    arguments: z.object({
      path: z.string(),
      edits: z
        .array(z.object({ oldText: z.string().min(1), newText: z.string() }))
        .min(1)
        .max(100),
    }),
  }),
  z.object({
    tool: z.literal("delete"),
    arguments: z.object({ path: z.string(), recursive: z.boolean().optional() }),
  }),
]);

/** Credential-free repository overlay persisted in Computer's VFS. */
export class PiRepositoryWorkspace {
  private readonly manifests = new Map<number, StoredRepositoryManifest>();
  private readonly pendingMutations = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: RepositoryWorkspaceFileSystem,
    private readonly now: () => number = () => Date.now(),
    options: { maxChangedFiles?: number } = {}
  ) {
    this.maxChangedFiles = options.maxChangedFiles ?? SESSION_DIFF_MAX_FILES;
  }

  private readonly maxChangedFiles: number;

  materialize(materializations: readonly PiRepositoryMaterialization[]): Promise<void> {
    return this.enqueue(async () => {
      for (const materialization of materializations) {
        await this.materializeOne(materialization);
      }
    });
  }

  prepareMutation(
    tool: RepositoryMutationName,
    args: Record<string, unknown>
  ): Promise<PreparedRepositoryMutation> {
    return this.enqueue(async () => {
      const request = repositoryMutationSchema.parse({ tool, arguments: args });
      if (request.tool === "delete" && request.arguments.recursive) {
        throw new Error("Repository editing supports file deletion only");
      }
      const target = this.resolveTarget(request.arguments.path);
      const existingStat = await this.statOrNull(target.absolutePath);
      const existingText = existingStat ? await this.readTextFile(target.absolutePath) : null;
      if (request.tool !== "write" && existingText === null) {
        throw new Error("Repository mutation requires an existing file");
      }
      if (request.tool === "write") assertBoundedText(request.arguments.content);
      if (request.tool === "edit") {
        let maximumBytes = new TextEncoder().encode(existingText ?? "").byteLength;
        for (const edit of request.arguments.edits) {
          assertBoundedText(edit.oldText);
          assertBoundedText(edit.newText);
          maximumBytes += new TextEncoder().encode(edit.newText).byteLength;
        }
        if (maximumBytes > MAX_TEXT_FILE_BYTES) {
          throw new Error(`Repository text exceeds ${MAX_TEXT_FILE_BYTES} bytes`);
        }
      }
      await this.ensureBaseline(target, existingText);
      const netChanges = await this.reconcileNetChanges();
      const changedPaths = netChanges.get(target.manifest.repository.position) ?? new Set<string>();
      const changedFileCount = [...netChanges.values()].reduce((sum, paths) => sum + paths.size, 0);
      if (!changedPaths.has(target.relativePath)) {
        if (changedFileCount >= this.maxChangedFiles) {
          throw new Error("Too many changed repository files");
        }
        changedPaths.add(target.relativePath);
        await this.writeChangedPaths(target.manifest.repository.position, changedPaths);
      }
      const mutationKey = this.mutationKey(
        target.manifest.repository.position,
        target.relativePath
      );
      this.pendingMutations.set(mutationKey, (this.pendingMutations.get(mutationKey) ?? 0) + 1);
      return { position: target.manifest.repository.position, path: target.relativePath };
    });
  }

  completeMutation(mutation: PreparedRepositoryMutation): Promise<void> {
    return this.enqueue(async () => {
      const key = this.mutationKey(mutation.position, mutation.path);
      const pending = this.pendingMutations.get(key) ?? 0;
      if (pending <= 1) this.pendingMutations.delete(key);
      else this.pendingMutations.set(key, pending - 1);
      await this.reconcileNetChanges();
    });
  }

  captureDiff(triggerMessageId: string | null): Promise<SessionDiffUpload> {
    return this.enqueue(async () => {
      const repositories = [];
      let totalPatchBytes = 0;
      const netChanges = await this.reconcileNetChanges();
      for (const manifest of [...this.manifests.values()].sort(
        (a, b) => a.repository.position - b.repository.position
      )) {
        const changedPaths = [...(netChanges.get(manifest.repository.position) ?? new Set())];
        const files: SessionDiffFileUpload[] = [];
        for (const path of changedPaths) {
          const tracked = manifest.files.find((file) => file.path === path);
          const absolutePath = `${manifest.repository.root}/${path}`;
          const current = await this.readTextFileOrNull(absolutePath);
          const previous = tracked
            ? await this.readTextFile(this.baselinePath(manifest.repository.position, path))
            : null;
          if (previous === current) continue;
          const status = previous === null ? "added" : current === null ? "deleted" : "modified";
          const oldText = previous ?? "";
          const newText = current ?? "";
          const { additions, deletions } = lineStats(oldText, newText);
          const patch = createGitPatch(path, oldText, newText, status, tracked?.mode ?? "100644");
          const patchBytes = new TextEncoder().encode(patch).byteLength;
          const renderable =
            patchBytes <= SESSION_DIFF_MAX_FILE_PATCH_BYTES &&
            totalPatchBytes + patchBytes <= SESSION_DIFF_MAX_TOTAL_PATCH_BYTES;
          if (renderable) totalPatchBytes += patchBytes;
          files.push({
            id: await fileId(manifest.repository.position, path),
            path,
            status,
            additions,
            deletions,
            renderState: renderable ? "renderable" : "too_large",
            oldMode: status === "added" ? "000000" : (tracked?.mode ?? "100644"),
            newMode: status === "deleted" ? "000000" : (tracked?.mode ?? "100644"),
            ...(renderable ? { patch } : {}),
          });
        }
        repositories.push({
          status: "ready" as const,
          position: manifest.repository.position,
          repoOwner: manifest.repository.repoOwner,
          repoName: manifest.repository.repoName,
          baseSha: manifest.repository.commitSha,
          // Like a Git worktree, uncommitted file changes leave HEAD at the base commit.
          headSha: manifest.repository.commitSha,
          truncated: false,
          omittedFileCount: 0,
          files,
        });
      }
      return sessionDiffUploadSchema.parse({
        version: 1,
        triggerMessageId,
        capturedAt: this.now(),
        repositories,
      });
    });
  }

  private async materializeOne(materialization: PiRepositoryMaterialization): Promise<void> {
    const manifest = toStoredManifest(materialization);
    const metadataRoot = this.metadataRoot(manifest.repository.position);
    const manifestPath = `${metadataRoot}/manifest.json`;
    const pendingPath = `${metadataRoot}/manifest.pending.json`;
    const stagingPath = `${STAGING_ROOT}/repository-${manifest.repository.position}`;
    await this.fs.mkdir(METADATA_ROOT, { recursive: true });
    await this.fs.mkdir(STAGING_ROOT, { recursive: true });

    const stored = await this.readManifestOrNull(manifestPath);
    if (stored) {
      assertSameManifest(stored, manifest);
      if (!(await this.statOrNull(stored.repository.root))) {
        throw new Error("Repository manifest exists without its materialized root");
      }
      await this.fs.rm(stagingPath, { recursive: true, force: true });
      this.manifests.set(stored.repository.position, stored);
      return;
    }

    const pending = await this.readManifestOrNull(pendingPath);
    if (pending && (await this.statOrNull(pending.repository.root))) {
      assertSameManifest(pending, manifest);
      await this.fs.rename(pendingPath, manifestPath);
      this.manifests.set(pending.repository.position, pending);
      return;
    }
    await this.fs.rm(stagingPath, { recursive: true, force: true });
    if (await this.statOrNull(manifest.repository.root)) {
      throw new Error(`Refusing to replace unmanaged workspace path: ${manifest.repository.root}`);
    }
    await this.fs.mkdir(stagingPath, { recursive: true });
    try {
      for (const file of materialization.files) {
        const destination = `${stagingPath}/${file.path}`;
        await this.fs.mkdir(parentPath(destination), { recursive: true });
        await this.fs.writeFile(destination, base64ToBytes(file.contentBase64), {
          mode: gitModeToFsMode(file.mode),
        });
      }
      await this.fs.mkdir(metadataRoot, { recursive: true });
      await this.fs.writeFile(pendingPath, JSON.stringify(manifest));
      await this.fs.rename(stagingPath, manifest.repository.root);
      await this.fs.rename(pendingPath, manifestPath);
      this.manifests.set(manifest.repository.position, manifest);
    } catch (error) {
      await this.fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private resolveTarget(path: string) {
    const manifest = [...this.manifests.values()].find((candidate) =>
      path.startsWith(`${candidate.repository.root}/`)
    );
    if (!manifest) throw new Error("Mutation path must be inside an attached repository");
    const relativePath = path.slice(manifest.repository.root.length + 1);
    if (!isRepositoryPath(relativePath)) {
      throw new Error("Mutation path must be inside an attached repository");
    }
    return {
      manifest,
      relativePath,
      absolutePath: `${manifest.repository.root}/${relativePath}`,
      tracked: manifest.files.find((file) => file.path === relativePath),
    };
  }

  private async ensureBaseline(
    target: ReturnType<PiRepositoryWorkspace["resolveTarget"]>,
    knownText: string | null
  ): Promise<void> {
    const position = target.manifest.repository.position;
    if (target.tracked) {
      const baselinePath = this.baselinePath(position, target.relativePath);
      if (!(await this.statOrNull(baselinePath))) {
        const original = knownText ?? (await this.readTextFile(target.absolutePath));
        await this.fs.mkdir(parentPath(baselinePath), { recursive: true });
        await this.fs.writeFile(baselinePath, original, {
          mode: gitModeToFsMode(target.tracked.mode),
        });
      }
    }
  }

  private async reconcileNetChanges(): Promise<Map<number, Set<string>>> {
    const result = new Map<number, Set<string>>();
    for (const manifest of this.manifests.values()) {
      const position = manifest.repository.position;
      const stored = await this.readChangedPaths(position);
      const net = new Set<string>();
      for (const path of stored) {
        if ((this.pendingMutations.get(this.mutationKey(position, path)) ?? 0) > 0) {
          net.add(path);
          continue;
        }
        const tracked = manifest.files.find((file) => file.path === path);
        const current = await this.readTextFileOrNull(`${manifest.repository.root}/${path}`);
        const baseline = tracked
          ? await this.readTextFile(this.baselinePath(position, path))
          : null;
        if (baseline !== current) net.add(path);
      }
      if (net.size !== stored.length) await this.writeChangedPaths(position, net);
      result.set(position, net);
    }
    const changedFileCount = [...result.values()].reduce((sum, paths) => sum + paths.size, 0);
    if (changedFileCount > this.maxChangedFiles)
      throw new Error("Too many changed repository files");
    return result;
  }

  private async readChangedPaths(position: number): Promise<string[]> {
    const raw = await this.readUtf8FileOrNull(this.changedPathsPath(position), MAX_METADATA_BYTES);
    return raw === null ? [] : changedPathsSchema.parse(JSON.parse(raw));
  }

  private writeChangedPaths(position: number, paths: Set<string>): Promise<void> {
    return this.fs.writeFile(this.changedPathsPath(position), JSON.stringify([...paths].sort()));
  }

  private async readManifestOrNull(path: string): Promise<StoredRepositoryManifest | null> {
    const raw = await this.readUtf8FileOrNull(path, MAX_METADATA_BYTES);
    return raw === null ? null : storedManifestSchema.parse(JSON.parse(raw));
  }

  private async readTextFile(path: string): Promise<string> {
    const stat = await this.fs.stat(path);
    if (!stat.isFile || stat.isSymbolicLink) throw new Error("Repository mutation requires a file");
    if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error("Repository file exceeds the text limit");
    return this.readUtf8File(path, MAX_TEXT_FILE_BYTES);
  }

  private async readTextFileOrNull(path: string): Promise<string | null> {
    return this.readUtf8FileOrNull(path, MAX_TEXT_FILE_BYTES);
  }

  private async readUtf8FileOrNull(path: string, maxBytes: number): Promise<string | null> {
    if (!(await this.statOrNull(path))) return null;
    return this.readUtf8File(path, maxBytes);
  }

  private async readUtf8File(path: string, maxBytes: number): Promise<string> {
    const result = await readBoundedBytes(await this.fs.readFile(path), maxBytes);
    if (!result.ok) throw new Error("Repository file exceeds the text limit");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(result.bytes);
    } catch {
      throw new Error("Repository mutation requires UTF-8 text");
    }
    if (content.includes("\0")) throw new Error("Repository mutation requires UTF-8 text");
    return content;
  }

  private async statOrNull(path: string): Promise<RepositoryWorkspaceStat | null> {
    try {
      return await this.fs.stat(path);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private metadataRoot(position: number): string {
    return `${METADATA_ROOT}/${position}`;
  }

  private baselinePath(position: number, path: string): string {
    return `${this.metadataRoot(position)}/baseline/${path}`;
  }

  private changedPathsPath(position: number): string {
    return `${this.metadataRoot(position)}/changes.json`;
  }

  private mutationKey(position: number, path: string): string {
    return `${position}:${path}`;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function toStoredManifest(materialization: PiRepositoryMaterialization): StoredRepositoryManifest {
  return {
    version: 1,
    repository: materialization.repository,
    files: materialization.files.map(({ contentBase64: _content, ...file }) => file),
  };
}

function assertSameManifest(
  existing: StoredRepositoryManifest,
  expected: StoredRepositoryManifest
) {
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error("Repository materialization does not match its durable manifest");
  }
}

function isRepositoryPath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function assertBoundedText(content: string): void {
  if (content.includes("\0")) throw new Error("Repository mutation requires UTF-8 text");
  if (new TextEncoder().encode(content).byteLength > MAX_TEXT_FILE_BYTES) {
    throw new Error(`Repository text exceeds ${MAX_TEXT_FILE_BYTES} bytes`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") ||
    (error instanceof Error && /(?:ENOENT|not found)/i.test(error.message))
  );
}

function gitModeToFsMode(mode: "100644" | "100755"): number {
  return mode === "100755" ? 0o100755 : 0o100644;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function lineStats(oldText: string, newText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldText, newText)) {
    if (change.added) additions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  return { additions, deletions };
}

function createGitPatch(
  path: string,
  oldText: string,
  newText: string,
  status: "added" | "modified" | "deleted",
  mode: "100644" | "100755"
): string {
  const oldPath = status === "added" ? "/dev/null" : `a/${path}`;
  const newPath = status === "deleted" ? "/dev/null" : `b/${path}`;
  const body = createTwoFilesPatch(oldPath, newPath, oldText, newText, "", "", { context: 3 })
    .split("\n")
    .slice(1)
    .join("\n");
  const modeLine =
    status === "added"
      ? `new file mode ${mode}`
      : status === "deleted"
        ? `deleted file mode ${mode}`
        : null;
  return [`diff --git a/${path} b/${path}`, modeLine, body].filter(Boolean).join("\n");
}

async function fileId(position: number, path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${position}:${path}`)
  );
  return `pi-${position}-${[...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
