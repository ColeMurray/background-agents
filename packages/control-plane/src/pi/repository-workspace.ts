import {
  SESSION_DIFF_MAX_FILES,
  type SessionDiffUpload,
} from "@open-inspect/shared/types/session-diffs";
import { z } from "zod";
import {
  PI_REPOSITORY_MAX_FILE_BYTES,
  PI_REPOSITORY_MAX_FILES,
  type PiRepositoryMaterialization,
} from "./repository-materialization-contract";
import { FULL_GIT_OBJECT_ID_PATTERN } from "../source-control/git-object-id";
import { readBoundedBytes } from "../http/bounded-body";
import {
  assembleSessionTextDiff,
  type SessionTextDiffRepository,
} from "../session/diffs/assembler";
import { WorkspaceMutationFifo } from "./computer-workspace-quota";

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
    arguments: z.object({ path: z.string().max(4_096), content: z.string() }),
  }),
  z.object({
    tool: z.literal("edit"),
    arguments: z.object({
      path: z.string().max(4_096),
      edits: z
        .array(z.object({ oldText: z.string().min(1), newText: z.string() }))
        .min(1)
        .max(100),
    }),
  }),
  z.object({
    tool: z.literal("delete"),
    arguments: z.object({ path: z.string().max(4_096), recursive: z.boolean().optional() }),
  }),
]);

/** Credential-free repository overlay persisted in Computer's VFS. */
export class PiRepositoryWorkspace {
  private readonly manifests = new Map<number, StoredRepositoryManifest>();
  private readonly pendingMutations = new Map<string, number>();
  private readonly mutations: WorkspaceMutationFifo;

  constructor(
    private readonly fs: RepositoryWorkspaceFileSystem,
    private readonly now: () => number = () => Date.now(),
    options: {
      maxChangedFiles?: number;
      maxLiveFiles?: number;
      mutations?: WorkspaceMutationFifo;
    } = {}
  ) {
    this.maxChangedFiles = options.maxChangedFiles ?? SESSION_DIFF_MAX_FILES;
    this.maxLiveFiles = options.maxLiveFiles ?? PI_REPOSITORY_MAX_FILES;
    this.mutations = options.mutations ?? new WorkspaceMutationFifo();
  }

  private readonly maxChangedFiles: number;
  private readonly maxLiveFiles: number;

  materialize(materializations: readonly PiRepositoryMaterialization[]): Promise<void> {
    return this.enqueue(async () => {
      for (const materialization of materializations) {
        await this.materializeOne(materialization);
      }
    });
  }

  /** Identify incomplete overlays before contacting the source provider. */
  restore(
    repositories: readonly {
      position: number;
      repoOwner: string;
      repoName: string;
      commitSha: string;
    }[]
  ): Promise<{ materializePositions: number[]; restoredFileCount: number }> {
    return this.enqueue(async () => {
      const restored: StoredRepositoryManifest[] = [];
      const materializePositions: number[] = [];
      for (const repository of repositories) {
        const manifest = await this.readManifestOrNull(
          `${this.metadataRoot(repository.position)}/manifest.json`
        );
        if (!manifest) {
          materializePositions.push(repository.position);
          continue;
        }
        if (
          manifest.repository.position !== repository.position ||
          manifest.repository.repoOwner !== repository.repoOwner ||
          manifest.repository.repoName !== repository.repoName ||
          manifest.repository.commitSha !== repository.commitSha ||
          manifest.repository.root !== `/workspace/repos/${repository.position}`
        ) {
          throw new Error("Repository workspace manifest does not match the durable session pins");
        }
        if (!(await this.isComplete(manifest))) {
          materializePositions.push(repository.position);
          continue;
        }
        restored.push(manifest);
      }
      const restoredFileCount = restored.reduce(
        (count, manifest) => count + manifest.files.length,
        0
      );
      if (restoredFileCount > this.maxLiveFiles) {
        throw new Error(`Repository workspace exceeds the ${this.maxLiveFiles} live file limit`);
      }
      this.manifests.clear();
      for (const manifest of restored) this.manifests.set(manifest.repository.position, manifest);
      return {
        materializePositions,
        restoredFileCount,
      };
    });
  }

  runMutation<T>(
    tool: RepositoryMutationName,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
    publish: (bundle: SessionDiffUpload) => Promise<void>,
    triggerMessageId: () => Promise<string | null>
  ): Promise<T> {
    return this.enqueue(async () => {
      const mutation = await this.prepareMutationUnlocked(tool, args);
      let result: T | undefined;
      let executionError: unknown;
      let executionFailed = false;
      try {
        result = await execute();
      } catch (error) {
        executionFailed = true;
        executionError = error;
      }
      await this.completeMutationUnlocked(mutation);
      await publish(await this.captureDiffUnlocked(await triggerMessageId()));
      if (executionFailed) throw executionError;
      return result as T;
    });
  }

  captureDiff(triggerMessageId: string | null): Promise<SessionDiffUpload> {
    return this.enqueue(() => this.captureDiffUnlocked(triggerMessageId));
  }

  private async captureDiffUnlocked(triggerMessageId: string | null): Promise<SessionDiffUpload> {
    const repositories: SessionTextDiffRepository[] = [];
    const netChanges = await this.reconcileNetChanges();
    for (const manifest of [...this.manifests.values()].sort(
      (a, b) => a.repository.position - b.repository.position
    )) {
      const changedPaths = [...(netChanges.get(manifest.repository.position) ?? new Set())];
      const files = [];
      for (const path of changedPaths) {
        const tracked = manifest.files.find((file) => file.path === path);
        const absolutePath = `${manifest.repository.root}/${path}`;
        const current = await this.readTextFileOrNull(absolutePath);
        const previous = tracked
          ? await this.readTextFile(this.baselinePath(manifest.repository.position, path))
          : null;
        files.push({
          path,
          before: previous,
          after: current,
          mode: tracked?.mode ?? "100644",
        });
      }
      repositories.push({
        position: manifest.repository.position,
        repoOwner: manifest.repository.repoOwner,
        repoName: manifest.repository.repoName,
        baseSha: manifest.repository.commitSha,
        files,
      });
    }
    return assembleSessionTextDiff(repositories, {
      triggerMessageId,
      capturedAt: this.now(),
    });
  }

  private async liveFileCount(
    netChanges: ReadonlyMap<number, ReadonlySet<string>>
  ): Promise<number> {
    let count = [...this.manifests.values()].reduce(
      (total, manifest) => total + manifest.files.length,
      0
    );
    for (const manifest of this.manifests.values()) {
      for (const path of netChanges.get(manifest.repository.position) ?? []) {
        const tracked = manifest.files.some((file) => file.path === path);
        const exists = (await this.statOrNull(`${manifest.repository.root}/${path}`)) !== null;
        if (tracked && !exists) count--;
        if (!tracked && exists) count++;
      }
    }
    return count;
  }

  private async prepareMutationUnlocked(
    tool: RepositoryMutationName,
    args: Record<string, unknown>
  ): Promise<PreparedRepositoryMutation> {
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
    if (request.tool === "write" && existingStat === null) {
      const liveFiles = await this.liveFileCount(netChanges);
      if (liveFiles >= this.maxLiveFiles) {
        throw new Error(`Repository workspace exceeds the ${this.maxLiveFiles} live file limit`);
      }
    }
    const changedPaths = netChanges.get(target.manifest.repository.position) ?? new Set<string>();
    const changedFileCount = [...netChanges.values()].reduce((sum, paths) => sum + paths.size, 0);
    if (!changedPaths.has(target.relativePath)) {
      if (changedFileCount >= this.maxChangedFiles) {
        throw new Error("Too many changed repository files");
      }
      changedPaths.add(target.relativePath);
      await this.writeChangedPaths(target.manifest.repository.position, changedPaths);
    }
    const mutationKey = this.mutationKey(target.manifest.repository.position, target.relativePath);
    this.pendingMutations.set(mutationKey, (this.pendingMutations.get(mutationKey) ?? 0) + 1);
    return { position: target.manifest.repository.position, path: target.relativePath };
  }

  private async completeMutationUnlocked(mutation: PreparedRepositoryMutation): Promise<void> {
    const key = this.mutationKey(mutation.position, mutation.path);
    const pending = this.pendingMutations.get(key) ?? 0;
    if (pending <= 1) this.pendingMutations.delete(key);
    else this.pendingMutations.set(key, pending - 1);
    await this.reconcileNetChanges();
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
      await this.repairStoredMaterialization(stored, materialization, stagingPath);
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

  private async isComplete(manifest: StoredRepositoryManifest): Promise<boolean> {
    const root = await this.statOrNull(manifest.repository.root);
    if (!root) return false;
    if (!root.isDirectory || root.isSymbolicLink) {
      throw new Error("Repository workspace root is not a durable directory");
    }
    const changedPaths = new Set(await this.readChangedPaths(manifest.repository.position));
    for (const file of manifest.files) {
      if (changedPaths.has(file.path)) {
        const baseline = await this.statOrNull(
          this.baselinePath(manifest.repository.position, file.path)
        );
        if (!baseline) return false;
        if (!baseline.isFile || baseline.isSymbolicLink) {
          throw new Error(`Repository baseline has an unsafe type: ${file.path}`);
        }
      }
      const stat = await this.statOrNull(`${manifest.repository.root}/${file.path}`);
      if (!stat) {
        if (!changedPaths.has(file.path)) return false;
        continue;
      }
      if (!stat.isFile || stat.isSymbolicLink) {
        throw new Error(`Repository workspace file has an unsafe type: ${file.path}`);
      }
    }
    return true;
  }

  private async repairStoredMaterialization(
    manifest: StoredRepositoryManifest,
    materialization: PiRepositoryMaterialization,
    stagingPath: string
  ): Promise<void> {
    const root = await this.statOrNull(manifest.repository.root);
    if (!root) {
      await this.fs.rm(stagingPath, { recursive: true, force: true });
      await this.fs.mkdir(stagingPath, { recursive: true });
      for (const file of materialization.files) {
        const destination = `${stagingPath}/${file.path}`;
        await this.fs.mkdir(parentPath(destination), { recursive: true });
        await this.fs.writeFile(destination, base64ToBytes(file.contentBase64), {
          mode: gitModeToFsMode(file.mode),
        });
      }
      await this.fs.mkdir(parentPath(manifest.repository.root), { recursive: true });
      await this.fs.rename(stagingPath, manifest.repository.root);
      return;
    }
    if (!root.isDirectory || root.isSymbolicLink) {
      throw new Error("Repository workspace root is not a durable directory");
    }
    const changedPaths = new Set(await this.readChangedPaths(manifest.repository.position));
    const sourceFiles = new Map(materialization.files.map((file) => [file.path, file]));
    for (const file of manifest.files) {
      const source = sourceFiles.get(file.path);
      if (!source) throw new Error(`Repository source is missing tracked file: ${file.path}`);
      if (changedPaths.has(file.path)) {
        const baseline = this.baselinePath(manifest.repository.position, file.path);
        const baselineStat = await this.statOrNull(baseline);
        if (!baselineStat) {
          await this.fs.mkdir(parentPath(baseline), { recursive: true });
          await this.fs.writeFile(baseline, base64ToBytes(source.contentBase64), {
            mode: gitModeToFsMode(source.mode),
          });
        } else if (!baselineStat.isFile || baselineStat.isSymbolicLink) {
          throw new Error(`Repository baseline has an unsafe type: ${file.path}`);
        }
      }
      const destination = `${manifest.repository.root}/${file.path}`;
      const stat = await this.statOrNull(destination);
      if (stat) {
        if (!stat.isFile || stat.isSymbolicLink) {
          throw new Error(`Repository workspace file has an unsafe type: ${file.path}`);
        }
        continue;
      }
      if (changedPaths.has(file.path)) continue;
      await this.fs.mkdir(parentPath(destination), { recursive: true });
      await this.fs.writeFile(destination, base64ToBytes(source.contentBase64), {
        mode: gitModeToFsMode(source.mode),
      });
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
    return this.mutations.run(operation);
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
