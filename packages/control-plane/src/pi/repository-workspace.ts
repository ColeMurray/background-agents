import {
  SESSION_DIFF_MAX_FILES,
  type SessionDiffUpload,
} from "@open-inspect/shared/types/session-diffs";
import { z } from "zod";
import {
  PI_REPOSITORY_MAX_FILE_BYTES,
  PI_REPOSITORY_MAX_FILES,
  PI_REPOSITORY_MAX_BYTES,
  PI_REPOSITORY_MAX_METADATA_BYTES,
  PI_REPOSITORY_MAX_PATH_BYTES,
  PI_REPOSITORY_MAX_DEPTH,
  PI_REPOSITORY_SESSION_MAX_ENTRIES,
  PI_REPOSITORY_SESSION_MAX_LIVE_BYTES,
  PI_REPOSITORY_SESSION_MAX_TOTAL_BYTES,
  isSafeRepositoryRelativePath,
  type PiRepositoryMaterialization,
} from "./repository-materialization-contract";
import { FULL_GIT_OBJECT_ID_PATTERN } from "../source-control/git-object-id";
import { readBoundedBytes } from "../http/bounded-body";
import {
  assembleSessionTextDiff,
  type SessionTextDiffRepository,
} from "../session/diffs/assembler";
import {
  WorkspaceMutationFifo,
  runCoordinatedComputerOperation,
} from "../pi/computer-workspace-quota";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";

const METADATA_ROOT = "/.open-inspect/repositories";
const STAGING_ROOT = "/.open-inspect/staging";
const MAX_TEXT_FILE_BYTES = PI_REPOSITORY_MAX_FILE_BYTES;
const MAX_METADATA_BYTES = PI_REPOSITORY_MAX_METADATA_BYTES;
const SCAN_PAGE_SIZE = 1_000;
const PUBLICATION_SCHEDULE_ATTEMPTS = 2;

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
  lstat(path: string): Promise<RepositoryWorkspaceStat>;
  readdir(
    path: string,
    options?: { limit?: number; offset?: number }
  ): Promise<
    Array<{
      name: string;
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      isSymbolicLink: boolean;
    }>
  >;
}

/** Route every repository-overlay VFS operation through Pi's SQLite queue. */
export function createCoordinatedRepositoryFileSystem(
  fs: RepositoryWorkspaceFileSystem,
  database: SqliteDatabase
): RepositoryWorkspaceFileSystem {
  const coordinate = <T>(operation: () => Promise<T>): Promise<T> =>
    runCoordinatedComputerOperation(database, operation);
  return {
    readFile: (...args) => coordinate(() => fs.readFile(...args)),
    writeFile: (...args) => coordinate(() => fs.writeFile(...args)),
    mkdir: (...args) => coordinate(() => fs.mkdir(...args)),
    rm: (...args) => coordinate(() => fs.rm(...args)),
    rename: (...args) => coordinate(() => fs.rename(...args)),
    lstat: (...args) => coordinate(() => fs.lstat(...args)),
    readdir: (...args) => coordinate(() => fs.readdir(...args)),
  };
}

interface StoredRepositoryManifest {
  version: 2;
  repository: PiRepositoryMaterialization["repository"];
  files: Array<{
    path: string;
    blobId: string;
    mode: "100644" | "100755";
    sizeBytes: number;
    contentSha256: string;
  }>;
}

interface LegacyStoredRepositoryManifest {
  version: 1;
  repository: PiRepositoryMaterialization["repository"];
  files: Array<Omit<StoredRepositoryManifest["files"][number], "contentSha256">>;
}

type DurableRepositoryManifest = StoredRepositoryManifest | LegacyStoredRepositoryManifest;

class LegacySourceNeedsProviderRepairError extends Error {}

const storedRepositorySchema = z.object({
  position: z.number().int().nonnegative(),
  repoOwner: z.string().trim().min(1).max(300),
  repoName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => !name.includes("/")),
  commitSha: z.string().regex(FULL_GIT_OBJECT_ID_PATTERN),
  root: z.string().min(1),
});
const storedFileMetadataSchema = z.object({
  path: z.string().min(1).refine(isSafeRepositoryRelativePath),
  blobId: z.string().trim().min(1).max(256),
  mode: z.enum(["100644", "100755"]),
  sizeBytes: z.number().int().nonnegative().max(PI_REPOSITORY_MAX_FILE_BYTES),
});

const storedManifestSchema = z
  .object({
    version: z.literal(2),
    repository: storedRepositorySchema,
    files: z
      .array(
        storedFileMetadataSchema.extend({
          contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
      )
      .max(PI_REPOSITORY_MAX_FILES),
  })
  .superRefine(validateStoredManifestShape);
const legacyStoredManifestSchema = z
  .object({
    version: z.literal(1),
    repository: storedRepositorySchema,
    files: z.array(storedFileMetadataSchema).max(PI_REPOSITORY_MAX_FILES),
  })
  .superRefine(validateStoredManifestShape);

function validateStoredManifestShape(
  manifest: {
    repository: { position: number; root: string };
    files: Array<{ path: string; sizeBytes: number }>;
  },
  context: z.RefinementCtx
): void {
  if (manifest.repository.root !== `/workspace/repos/${manifest.repository.position}`) {
    context.addIssue({ code: "custom", path: ["repository", "root"], message: "Invalid root" });
  }
  const paths = new Set<string>();
  let bytes = 0;
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Duplicate path",
      });
    }
    paths.add(file.path);
    bytes += file.sizeBytes;
  }
  if (bytes > PI_REPOSITORY_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["files"], message: "Manifest is too large" });
  }
}
const changedPathsSchema = z
  .array(z.string().min(1).refine(isSafeRepositoryRelativePath))
  .max(SESSION_DIFF_MAX_FILES);

export type RepositoryMutationName = "write" | "edit" | "delete";

interface PreparedRepositoryMutation {
  readonly position: number;
  readonly path: string;
}

interface RepositoryMutationResult<T> {
  value: T;
  mutation: "applied" | "failed";
  projection: "published" | "pending" | "failed";
}

interface RepositoryDiffPublication {
  stage(bundle: SessionDiffUpload): Promise<unknown>;
  drain(): Promise<"published" | "idle" | "pending" | "permanent">;
  recordCaptureFailure(error: unknown): Promise<void>;
  recordFailure(error: unknown): Promise<void>;
  reportFailure(error: unknown): Promise<void>;
  schedule(): Promise<void>;
}

const repositoryMutationSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("write"),
    arguments: z.object({
      path: z.string().refine(isBoundedAbsoluteRepositoryPath),
      content: z.string(),
    }),
  }),
  z.object({
    tool: z.literal("edit"),
    arguments: z.object({
      path: z.string().refine(isBoundedAbsoluteRepositoryPath),
      edits: z
        .array(z.object({ oldText: z.string().min(1), newText: z.string() }))
        .min(1)
        .max(100),
    }),
  }),
  z.object({
    tool: z.literal("delete"),
    arguments: z.object({
      path: z.string().refine(isBoundedAbsoluteRepositoryPath),
      recursive: z.boolean().optional(),
    }),
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
      maxLiveBytes?: number;
      maxEntries?: number;
      maxTotalBytes?: number;
      mutations?: WorkspaceMutationFifo;
      publication?: RepositoryDiffPublication;
    } = {}
  ) {
    this.maxChangedFiles = options.maxChangedFiles ?? SESSION_DIFF_MAX_FILES;
    this.maxLiveFiles = options.maxLiveFiles ?? PI_REPOSITORY_MAX_FILES;
    this.maxLiveBytes = options.maxLiveBytes ?? PI_REPOSITORY_SESSION_MAX_LIVE_BYTES;
    this.maxEntries = options.maxEntries ?? PI_REPOSITORY_SESSION_MAX_ENTRIES;
    this.maxTotalBytes = options.maxTotalBytes ?? PI_REPOSITORY_SESSION_MAX_TOTAL_BYTES;
    this.mutations = options.mutations ?? new WorkspaceMutationFifo();
    this.publication = options.publication;
  }

  private readonly maxChangedFiles: number;
  private readonly maxLiveFiles: number;
  private readonly maxLiveBytes: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly publication: RepositoryDiffPublication | undefined;

  materialize(materializations: readonly PiRepositoryMaterialization[]): Promise<void> {
    return this.enqueue(async () => {
      await this.preflightMaterializations(materializations);
      const newPositions: number[] = [];
      for (const materialization of materializations) {
        const position = materialization.repository.position;
        const manifest = await this.statOrNull(`${this.metadataRoot(position)}/manifest.json`);
        const root = await this.statOrNull(materialization.repository.root);
        if (!manifest && !root) newPositions.push(position);
      }
      try {
        for (const materialization of materializations) {
          await this.materializeOne(materialization);
        }
        await this.assertAggregateLimits();
        await this.assertRepositoryRoots([...this.manifests.keys()], true);
      } catch (error) {
        for (const position of newPositions) {
          await this.fs
            .rm(`/workspace/repos/${position}`, { recursive: true, force: true })
            .catch(() => {});
          await this.fs
            .rm(this.metadataRoot(position), { recursive: true, force: true })
            .catch(() => {});
          this.manifests.delete(position);
        }
        throw error;
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
  ): Promise<{ materializePositions: number[] }> {
    return this.enqueue(async () => {
      for (const repository of repositories) {
        await this.fs.rm(`${this.metadataRoot(repository.position)}/manifest.migrating.json`, {
          force: true,
        });
      }
      await this.fs.rm(STAGING_ROOT, { recursive: true, force: true });
      await this.assertRepositoryRoots(
        repositories.map((repository) => repository.position),
        false
      );
      const restored: StoredRepositoryManifest[] = [];
      const promotions: StoredRepositoryManifest[] = [];
      const materializePositions: number[] = [];
      for (const repository of repositories) {
        const manifestPath = `${this.metadataRoot(repository.position)}/manifest.json`;
        const pendingPath = `${this.metadataRoot(repository.position)}/manifest.pending.json`;
        let durableManifest = await this.readManifestOrNull(manifestPath);
        let fromPending = false;
        if (!durableManifest && (await this.statOrNull(repositoryRoot(repository.position)))) {
          durableManifest = await this.readManifestOrNull(pendingPath);
          fromPending = durableManifest !== null;
        }
        if (!durableManifest) {
          materializePositions.push(repository.position);
          continue;
        }
        const manifest =
          durableManifest.version === 1
            ? await this.migrateLegacyManifest(durableManifest)
            : durableManifest;
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
        const completeness = await this.isComplete(manifest);
        if (!completeness.complete) {
          if (!completeness.repairable) {
            throw new Error(completeness.reason ?? "Repository workspace is corrupt");
          }
          materializePositions.push(repository.position);
          continue;
        }
        if (durableManifest.version === 1 || fromPending) promotions.push(manifest);
        restored.push(manifest);
      }
      const liveFiles = (await this.aggregateWorkspaceUsage()).liveFiles;
      if (liveFiles > this.maxLiveFiles) {
        throw new Error(`Repository workspace exceeds the ${this.maxLiveFiles} live file limit`);
      }
      await this.assertAggregateLimits();
      await this.assertManifestMigrationsFit(promotions);
      for (const promotion of promotions) {
        await this.writeManifestAtomically(promotion);
        await this.fs.rm(
          `${this.metadataRoot(promotion.repository.position)}/manifest.pending.json`,
          {
            force: true,
          }
        );
      }
      this.manifests.clear();
      for (const manifest of restored) this.manifests.set(manifest.repository.position, manifest);
      return {
        materializePositions,
      };
    });
  }

  runMutation<T>(
    tool: RepositoryMutationName,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
    publish: (bundle: SessionDiffUpload) => Promise<void>,
    triggerMessageId: () => Promise<string | null>
  ): Promise<RepositoryMutationResult<T>> {
    return this.runMutationOutsidePublication(tool, args, execute, publish, triggerMessageId);
  }

  private async runMutationOutsidePublication<T>(
    tool: RepositoryMutationName,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
    publish: (bundle: SessionDiffUpload) => Promise<void>,
    triggerMessageId: () => Promise<string | null>
  ): Promise<RepositoryMutationResult<T>> {
    const local = await this.enqueue(async () => {
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
      let bundle: SessionDiffUpload | null = null;
      let localFailure: unknown;
      let stageFailed = false;
      let armed = false;
      if (this.publication) {
        try {
          bundle = await this.captureDiffUnlocked(await triggerMessageId());
        } catch (error) {
          localFailure = error;
          await this.publication.recordCaptureFailure(error).catch(() => {});
        }
        if (bundle) {
          try {
            await this.publication.stage(bundle);
          } catch (error) {
            stageFailed = true;
            localFailure = error;
            await this.publication.recordCaptureFailure(error).catch(() => {});
            bundle = null;
          }
        }
        armed = await this.armPublication(this.publication);
      } else {
        bundle = await this.captureDiffUnlocked(await triggerMessageId());
      }
      return {
        value: result as T,
        mutation: isErrorResult(result) ? ("failed" as const) : ("applied" as const),
        executionFailed,
        executionError,
        bundle,
        localFailure,
        stageFailed,
        armed,
      };
    });
    let projection: RepositoryMutationResult<T>["projection"];
    if (!this.publication) {
      await publish(local.bundle!);
      projection = "published";
    } else if (local.armed && !local.stageFailed) {
      projection = "pending";
    } else {
      try {
        const outcome = await this.publication.drain();
        projection = local.stageFailed ? "failed" : projectionFromOutcome(outcome, false);
      } catch (error) {
        await this.publication.recordFailure(error).catch(() => {});
        local.localFailure ??= error;
        projection = "failed";
      }
    }
    if (local.localFailure)
      await this.publication?.reportFailure(local.localFailure).catch(() => {});
    if (local.executionFailed) throw local.executionError;
    return { value: local.value, mutation: local.mutation, projection };
  }

  private async armPublication(publication: RepositoryDiffPublication): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PUBLICATION_SCHEDULE_ATTEMPTS; attempt++) {
      try {
        await publication.schedule();
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    await publication
      .recordFailure(lastError ?? new Error("Diff retry scheduling failed"))
      .catch(() => {});
    return false;
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
    const aggregate = await this.aggregateWorkspaceUsage();
    const nextLiveBytes =
      aggregate.liveBytes -
      (existingStat?.size ?? 0) +
      projectedMutationBytes(request, existingText);
    if (nextLiveBytes > this.maxLiveBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxLiveBytes} live byte limit`);
    }
    const netChanges = await this.reconcileNetChanges();
    if (request.tool === "write" && existingStat === null) {
      const liveFiles = await this.liveFileCount(netChanges);
      if (liveFiles >= this.maxLiveFiles) {
        throw new Error(`Repository workspace exceeds the ${this.maxLiveFiles} live file limit`);
      }
    }
    const changedPaths = netChanges.get(target.manifest.repository.position) ?? new Set<string>();
    const changedFileCount = [...netChanges.values()].reduce((sum, paths) => sum + paths.size, 0);
    const addingChangedPath = !changedPaths.has(target.relativePath);
    if (addingChangedPath) {
      if (changedFileCount >= this.maxChangedFiles) {
        throw new Error("Too many changed repository files");
      }
    }
    const baselinePath = this.baselinePath(
      target.manifest.repository.position,
      target.relativePath
    );
    const baselineMissing =
      target.tracked !== undefined && (await this.statOrNull(baselinePath)) === null;
    const changesPath = this.changedPathsPath(target.manifest.repository.position);
    const existingChanges = await this.statOrNull(changesPath);
    const creationPaths: string[] = [];
    if (request.tool === "write" && existingStat === null) creationPaths.push(target.absolutePath);
    if (baselineMissing) creationPaths.push(baselinePath);
    if (addingChangedPath && existingChanges === null) {
      creationPaths.push(changesPath);
    }
    const addedEntries = await this.missingEntriesForFiles(creationPaths);
    if (aggregate.entries + addedEntries > this.maxEntries) {
      throw new Error(`Repository workspace exceeds the ${this.maxEntries} total entry limit`);
    }
    const projectedMetadataBytes = baselineMissing ? (existingStat?.size ?? 0) : 0;
    let changedMetadataBytes = existingChanges?.size ?? 0;
    if (addingChangedPath) {
      const projectedChangedPaths = new Set(changedPaths);
      projectedChangedPaths.add(target.relativePath);
      changedMetadataBytes = new TextEncoder().encode(
        JSON.stringify([...projectedChangedPaths].sort())
      ).byteLength;
    }
    if (
      aggregate.totalBytes -
        (existingStat?.size ?? 0) +
        projectedMutationBytes(request, existingText) +
        projectedMetadataBytes +
        changedMetadataBytes -
        (existingChanges?.size ?? 0) >
      this.maxTotalBytes
    ) {
      throw new Error(`Repository workspace exceeds the ${this.maxTotalBytes} total byte limit`);
    }
    await this.ensureBaseline(target, existingText);
    if (addingChangedPath) {
      changedPaths.add(target.relativePath);
      await this.writeChangedPaths(target.manifest.repository.position, changedPaths);
    }
    const mutationKey = this.mutationKey(target.manifest.repository.position, target.relativePath);
    this.pendingMutations.set(mutationKey, (this.pendingMutations.get(mutationKey) ?? 0) + 1);
    return {
      position: target.manifest.repository.position,
      path: target.relativePath,
    };
  }

  private async completeMutationUnlocked(mutation: PreparedRepositoryMutation): Promise<void> {
    const key = this.mutationKey(mutation.position, mutation.path);
    const pending = this.pendingMutations.get(key) ?? 0;
    if (pending <= 1) this.pendingMutations.delete(key);
    else this.pendingMutations.set(key, pending - 1);
    const changes = await this.reconcileNetChanges();
    if (!changes.get(mutation.position)?.has(mutation.path)) {
      const baseline = this.baselinePath(mutation.position, mutation.path);
      await this.fs.rm(baseline, { force: true });
      await this.removeEmptyParents(
        parentPath(baseline),
        `${this.metadataRoot(mutation.position)}/baseline`
      );
    }
    await this.assertAggregateLimits();
  }

  private async materializeOne(materialization: PiRepositoryMaterialization): Promise<void> {
    const manifest = await toStoredManifest(materialization);
    const metadataRoot = this.metadataRoot(manifest.repository.position);
    const manifestPath = `${metadataRoot}/manifest.json`;
    const pendingPath = `${metadataRoot}/manifest.pending.json`;
    const stagingPath = `${STAGING_ROOT}/repository-${manifest.repository.position}`;
    await this.fs.mkdir(METADATA_ROOT, { recursive: true });
    await this.fs.mkdir(STAGING_ROOT, { recursive: true });

    const stored = await this.readManifestOrNull(manifestPath);
    if (stored) {
      if (stored.version === 1) assertSameLegacyManifest(stored, manifest);
      else assertSameManifest(stored, manifest);
      await this.repairStoredMaterialization(manifest, materialization, stagingPath);
      await this.requireCompleteManifest(manifest);
      if (stored.version === 1) await this.writeManifestAtomically(manifest);
      await this.fs.rm(stagingPath, { recursive: true, force: true });
      this.manifests.set(manifest.repository.position, manifest);
      return;
    }

    const pending = await this.readManifestOrNull(pendingPath);
    if (pending?.version === 2 && (await this.statOrNull(pending.repository.root))) {
      assertSameManifest(pending, manifest);
      await this.fs.rename(pendingPath, manifestPath);
      await this.requireCompleteManifest(pending);
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
      await this.fs.writeFile(pendingPath, encodeStoredManifest(manifest));
      await this.fs.rename(stagingPath, manifest.repository.root);
      await this.fs.rename(pendingPath, manifestPath);
      this.manifests.set(manifest.repository.position, manifest);
    } catch (error) {
      await this.fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async migrateLegacyManifest(
    legacy: LegacyStoredRepositoryManifest
  ): Promise<StoredRepositoryManifest | null> {
    const root = await this.statOrNull(legacy.repository.root);
    if (!root) return null;
    if (!root.isDirectory || root.isSymbolicLink) {
      throw new Error("Repository workspace root is not a durable directory");
    }
    const changedPaths = new Set(await this.readChangedPaths(legacy.repository.position));
    const trackedPaths = new Set(legacy.files.map((file) => file.path));
    const files: StoredRepositoryManifest["files"] = [];
    const fatal: string[] = [];
    let repairable = false;
    for (const file of legacy.files) {
      const currentPath = `${legacy.repository.root}/${file.path}`;
      const current = await this.statOrNull(currentPath);
      const sourcePath = changedPaths.has(file.path)
        ? this.baselinePath(legacy.repository.position, file.path)
        : currentPath;
      const source = await this.statOrNull(sourcePath);
      if (!source) {
        if (changedPaths.has(file.path)) repairable = true;
        else fatal.push(`Repository unchanged file is missing: ${file.path}`);
      } else {
        try {
          files.push({
            ...file,
            contentSha256: await this.hashExpectedSourceFile(source, sourcePath, file),
          });
        } catch (error) {
          if (error instanceof LegacySourceNeedsProviderRepairError) repairable = true;
          else fatal.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (changedPaths.has(file.path) && current) {
        try {
          if (!current.isFile || current.isSymbolicLink || !modeMatches(current.mode, file.mode)) {
            throw new Error(`Repository changed file has an unsafe mode or type: ${file.path}`);
          }
          await this.readTextFile(currentPath);
        } catch (error) {
          fatal.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    for (const path of await this.listRepositoryFiles(legacy.repository.root)) {
      if (!trackedPaths.has(path) && !changedPaths.has(path)) {
        fatal.push(`Repository workspace has an unexplained extra file: ${path}`);
        continue;
      }
      if (!trackedPaths.has(path)) {
        try {
          await this.validateAddedFile(legacy.repository.root, path);
        } catch (error) {
          fatal.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (fatal.length > 0) throw new Error(fatal[0]);
    if (repairable) return null;
    const manifest = storedManifestSchema.parse({
      version: 2,
      repository: legacy.repository,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    });
    encodeStoredManifest(manifest);
    return manifest;
  }

  private async hashExpectedSourceFile(
    stat: RepositoryWorkspaceStat,
    path: string,
    expected: LegacyStoredRepositoryManifest["files"][number]
  ): Promise<string> {
    if (!stat.isFile || stat.isSymbolicLink) {
      throw new Error(`Repository source has an unsafe type: ${expected.path}`);
    }
    if (stat.size !== expected.sizeBytes) {
      throw new Error(`Repository source size does not match manifest: ${expected.path}`);
    }
    if (!modeMatches(stat.mode, expected.mode)) {
      throw new Error(`Repository source mode does not match manifest: ${expected.path}`);
    }
    const bytes = await readBoundedBytes(await this.fs.readFile(path), expected.sizeBytes + 1);
    if (!bytes.ok) throw new Error(`Repository source exceeds manifest size: ${expected.path}`);
    const objectId = await gitBlobObjectId(bytes.bytes, expected.blobId.length);
    if (objectId === null || objectId !== expected.blobId.toLowerCase()) {
      throw new LegacySourceNeedsProviderRepairError(
        `Repository source Git object does not match manifest: ${expected.path}`
      );
    }
    return sha256(bytes.bytes);
  }

  private async validateAddedFile(root: string, path: string): Promise<void> {
    const absolutePath = `${root}/${path}`;
    const stat = await this.fs.lstat(absolutePath);
    if (!stat.isFile || stat.isSymbolicLink || !modeMatches(stat.mode, "100644")) {
      throw new Error(`Repository addition has an unsafe mode or type: ${path}`);
    }
    await this.readTextFile(absolutePath);
  }

  private async requireCompleteManifest(manifest: StoredRepositoryManifest): Promise<void> {
    const completeness = await this.isComplete(manifest);
    if (!completeness.complete) {
      throw new Error(completeness.reason ?? "Repository workspace repair is incomplete");
    }
  }

  private async writeManifestAtomically(manifest: StoredRepositoryManifest): Promise<void> {
    const root = this.metadataRoot(manifest.repository.position);
    const destination = `${root}/manifest.json`;
    const pending = `${root}/manifest.migrating.json`;
    const encoded = encodeStoredManifest(manifest);
    await this.assertAggregateLimits();
    const usage = await this.aggregateWorkspaceUsage();
    const encodedBytes = new TextEncoder().encode(encoded).byteLength;
    if (usage.totalBytes + encodedBytes > this.maxTotalBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxTotalBytes} total byte limit`);
    }
    if (usage.entries + 1 > this.maxEntries) {
      throw new Error(`Repository workspace exceeds the ${this.maxEntries} total entry limit`);
    }
    await this.fs.mkdir(root, { recursive: true });
    try {
      await this.fs.writeFile(pending, encoded);
      await this.fs.rename(pending, destination);
    } catch (error) {
      await this.fs.rm(pending, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async assertManifestMigrationsFit(
    manifests: readonly StoredRepositoryManifest[]
  ): Promise<void> {
    if (manifests.length === 0) return;
    const usage = await this.aggregateWorkspaceUsage();
    let totalBytes = usage.totalBytes;
    let largestManifestBytes = 0;
    for (const manifest of manifests) {
      const destination = `${this.metadataRoot(manifest.repository.position)}/manifest.json`;
      const existing = await this.statOrNull(destination);
      totalBytes -= existing?.size ?? 0;
      const manifestBytes = new TextEncoder().encode(encodeStoredManifest(manifest)).byteLength;
      totalBytes += manifestBytes;
      largestManifestBytes = Math.max(largestManifestBytes, manifestBytes);
    }
    if (totalBytes > this.maxTotalBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxTotalBytes} total byte limit`);
    }
    if (usage.totalBytes + largestManifestBytes > this.maxTotalBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxTotalBytes} total byte limit`);
    }
    if (usage.entries + 1 > this.maxEntries) {
      throw new Error(`Repository workspace exceeds the ${this.maxEntries} total entry limit`);
    }
  }

  private async isComplete(
    manifest: StoredRepositoryManifest
  ): Promise<{ complete: boolean; repairable: boolean; reason?: string }> {
    const root = await this.statOrNull(manifest.repository.root);
    if (!root) return { complete: false, repairable: true };
    if (!root.isDirectory || root.isSymbolicLink) {
      throw new Error("Repository workspace root is not a durable directory");
    }
    const changedPaths = new Set(await this.readChangedPaths(manifest.repository.position));
    const trackedPaths = new Set(manifest.files.map((file) => file.path));
    let repairable = false;
    const fatal: string[] = [];
    for (const file of manifest.files) {
      if (changedPaths.has(file.path)) {
        const baseline = await this.statOrNull(
          this.baselinePath(manifest.repository.position, file.path)
        );
        if (!baseline) repairable = true;
        else {
          try {
            if (!baseline.isFile || baseline.isSymbolicLink) {
              throw new Error(`Repository baseline has an unsafe type: ${file.path}`);
            }
            await this.assertStoredFile(
              baseline,
              this.baselinePath(manifest.repository.position, file.path),
              file,
              "baseline"
            );
          } catch (error) {
            fatal.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      const stat = await this.statOrNull(`${manifest.repository.root}/${file.path}`);
      if (!stat) {
        if (!changedPaths.has(file.path)) {
          fatal.push(`Repository unchanged file is missing: ${file.path}`);
        }
        continue;
      }
      try {
        if (!stat.isFile || stat.isSymbolicLink) {
          throw new Error(`Repository workspace file has an unsafe type: ${file.path}`);
        }
        if (changedPaths.has(file.path)) {
          if (!modeMatches(stat.mode, file.mode)) {
            throw new Error(`Repository changed file mode does not match manifest: ${file.path}`);
          }
          await this.readTextFile(`${manifest.repository.root}/${file.path}`);
        } else {
          await this.assertStoredFile(
            stat,
            `${manifest.repository.root}/${file.path}`,
            file,
            "unchanged file"
          );
        }
      } catch (error) {
        fatal.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const path of await this.listRepositoryFiles(manifest.repository.root)) {
      if (!trackedPaths.has(path) && !changedPaths.has(path)) {
        fatal.push(`Repository workspace has an unexplained extra file: ${path}`);
        continue;
      }
      if (!trackedPaths.has(path)) {
        try {
          await this.validateAddedFile(manifest.repository.root, path);
        } catch (error) {
          fatal.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (fatal.length > 0) return { complete: false, repairable: false, reason: fatal[0] };
    return repairable
      ? { complete: false, repairable: true, reason: "Repository baseline repair is required" }
      : { complete: true, repairable: false };
  }

  private async repairStoredMaterialization(
    manifest: StoredRepositoryManifest,
    materialization: PiRepositoryMaterialization,
    stagingPath: string
  ): Promise<void> {
    const root = await this.statOrNull(manifest.repository.root);
    const changedPaths = new Set(await this.readChangedPaths(manifest.repository.position));
    if (!root) {
      if (changedPaths.size > 0) {
        throw new Error("Repository root cannot be repaired without undoing durable changes");
      }
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
        } else if (!(await this.matchesStoredFile(baselineStat, baseline, file))) {
          await this.fs.writeFile(baseline, base64ToBytes(source.contentBase64), {
            mode: gitModeToFsMode(source.mode),
          });
        }
      }
      const destination = `${manifest.repository.root}/${file.path}`;
      const stat = await this.statOrNull(destination);
      if (stat) {
        if (!stat.isFile || stat.isSymbolicLink) {
          throw new Error(`Repository workspace file has an unsafe type: ${file.path}`);
        }
        if (
          !changedPaths.has(file.path) &&
          !(await this.matchesStoredFile(stat, destination, file))
        ) {
          await this.fs.writeFile(destination, base64ToBytes(source.contentBase64), {
            mode: gitModeToFsMode(source.mode),
          });
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

  private async preflightMaterializations(
    materializations: readonly PiRepositoryMaterialization[]
  ): Promise<void> {
    const usage = await this.aggregateWorkspaceUsage();
    let liveBytes = usage.liveBytes;
    let liveFiles = await this.liveFileCount(await this.reconcileNetChanges());
    for (const materialization of materializations) {
      if (await this.statOrNull(materialization.repository.root)) continue;
      liveFiles += materialization.files.length;
      liveBytes += materialization.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    }
    if (liveFiles > this.maxLiveFiles) {
      throw new Error(`Repository workspace exceeds the ${this.maxLiveFiles} live file limit`);
    }
    if (liveBytes > this.maxLiveBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxLiveBytes} live byte limit`);
    }
  }

  private async assertAggregateLimits(): Promise<void> {
    const usage = await this.aggregateWorkspaceUsage();
    if (usage.liveFiles > this.maxLiveFiles) {
      throw new Error(`Repository workspace exceeds the ${this.maxLiveFiles} live file limit`);
    }
    if (usage.liveBytes > this.maxLiveBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxLiveBytes} live byte limit`);
    }
    if (usage.entries > this.maxEntries) {
      throw new Error(`Repository workspace exceeds the ${this.maxEntries} total entry limit`);
    }
    if (usage.totalBytes > this.maxTotalBytes) {
      throw new Error(`Repository workspace exceeds the ${this.maxTotalBytes} total byte limit`);
    }
  }

  private async aggregateWorkspaceUsage(): Promise<{
    liveBytes: number;
    liveFiles: number;
    totalBytes: number;
    entries: number;
  }> {
    const live = await this.scanTree("/workspace/repos");
    const metadata = await this.scanTree("/.open-inspect");
    return {
      liveBytes: live.bytes,
      liveFiles: live.files,
      totalBytes: live.bytes + metadata.bytes,
      entries: live.entries + metadata.entries,
    };
  }

  private async scanTree(root: string): Promise<{ bytes: number; files: number; entries: number }> {
    const rootStat = await this.statOrNull(root);
    if (!rootStat) return { bytes: 0, files: 0, entries: 0 };
    if (!rootStat.isDirectory || rootStat.isSymbolicLink) {
      throw new Error(`Repository storage root is not a real directory: ${root}`);
    }
    const pending = [root];
    let bytes = 0;
    let files = 0;
    let entries = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
        const page = await this.fs.readdir(directory, { limit: SCAN_PAGE_SIZE, offset });
        for (const entry of page) {
          if (entry.isSymbolicLink)
            throw new Error("Repository workspace contains a symbolic link");
          const path = `${directory}/${entry.name}`;
          const relative = path.slice(root.length + 1);
          if (relative && !isSafeStorageRelativePath(root, relative)) {
            throw new Error(`Repository workspace path exceeds depth or UTF-8 limit: ${relative}`);
          }
          entries += 1;
          if (entry.isDirectory) pending.push(path);
          else if (entry.isFile) {
            bytes += entry.size;
            files += 1;
          }
          if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(entries)) {
            throw new Error("Repository workspace accounting overflowed");
          }
        }
        if (page.length < SCAN_PAGE_SIZE) break;
      }
    }
    return { bytes, files, entries };
  }

  private async assertRepositoryRoots(
    positions: readonly number[],
    requireAll: boolean
  ): Promise<void> {
    const expected = new Set(positions.map(String));
    const actual = new Set<string>();
    for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
      const page = await this.fs.readdir("/workspace/repos", {
        limit: SCAN_PAGE_SIZE,
        offset,
      });
      for (const entry of page) {
        if (
          !entry.isDirectory ||
          entry.isSymbolicLink ||
          !/^(?:0|[1-9][0-9]{0,9})$/.test(entry.name)
        ) {
          throw new Error(`Repository workspace has an unsafe top-level root: ${entry.name}`);
        }
        if (!expected.has(entry.name)) {
          throw new Error(`Repository workspace has an unattached top-level root: ${entry.name}`);
        }
        actual.add(entry.name);
      }
      if (page.length < SCAN_PAGE_SIZE) break;
    }
    if (requireAll && [...expected].some((position) => !actual.has(position))) {
      throw new Error("Repository workspace root set does not match attached session positions");
    }
  }

  private async missingEntriesForFiles(paths: readonly string[]): Promise<number> {
    const candidates = new Set<string>();
    for (const path of paths) {
      let current = path;
      while (current !== "/") {
        candidates.add(current);
        current = parentPath(current);
      }
    }
    let missing = 0;
    for (const path of candidates) {
      if (!(await this.statOrNull(path))) missing += 1;
    }
    return missing;
  }

  private async assertStoredFile(
    stat: RepositoryWorkspaceStat,
    path: string,
    expected: StoredRepositoryManifest["files"][number],
    label: string
  ): Promise<void> {
    if (stat.size !== expected.sizeBytes) {
      throw new Error(`Repository ${label} size does not match manifest: ${expected.path}`);
    }
    if (!modeMatches(stat.mode, expected.mode)) {
      throw new Error(`Repository ${label} mode does not match manifest: ${expected.path}`);
    }
    const bytes = await readBoundedBytes(await this.fs.readFile(path), expected.sizeBytes + 1);
    if (!bytes.ok || (await sha256(bytes.bytes)) !== expected.contentSha256) {
      throw new Error(`Repository ${label} hash does not match manifest: ${expected.path}`);
    }
  }

  private async matchesStoredFile(
    stat: RepositoryWorkspaceStat,
    path: string,
    expected: StoredRepositoryManifest["files"][number]
  ): Promise<boolean> {
    if (stat.size !== expected.sizeBytes || !modeMatches(stat.mode, expected.mode)) return false;
    const bytes = await readBoundedBytes(await this.fs.readFile(path), expected.sizeBytes + 1);
    return bytes.ok && (await sha256(bytes.bytes)) === expected.contentSha256;
  }

  private async listRepositoryFiles(root: string): Promise<string[]> {
    const pending = [root];
    const files: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
        const page = await this.fs.readdir(directory, { limit: SCAN_PAGE_SIZE, offset });
        for (const entry of page) {
          if (entry.isSymbolicLink)
            throw new Error("Repository workspace contains a symbolic link");
          const absolute = `${directory}/${entry.name}`;
          const relative = absolute.slice(root.length + 1);
          if (!isSafeRepositoryRelativePath(relative)) {
            throw new Error(`Repository workspace path exceeds depth or UTF-8 limit: ${relative}`);
          }
          if (entry.isDirectory) pending.push(absolute);
          else if (entry.isFile) files.push(relative);
        }
        if (page.length < SCAN_PAGE_SIZE) break;
      }
    }
    return files.sort();
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
      if (net.size === 0 || !samePaths(stored, net)) {
        await this.persistChangedPaths(position, net);
      }
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
    const encoded = JSON.stringify([...paths].sort());
    if (
      encoded.length > MAX_METADATA_BYTES ||
      new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES
    ) {
      throw new Error("Repository changed-path metadata exceeds the durable metadata limit");
    }
    return this.fs.writeFile(this.changedPathsPath(position), encoded);
  }

  private persistChangedPaths(position: number, paths: Set<string>): Promise<void> {
    return paths.size === 0
      ? this.fs.rm(this.changedPathsPath(position), { force: true })
      : this.writeChangedPaths(position, paths);
  }

  private async removeEmptyParents(path: string, stop: string): Promise<void> {
    let current = path;
    while (current === stop || current.startsWith(`${stop}/`)) {
      if (!(await this.statOrNull(current))) {
        if (current === stop) return;
        current = parentPath(current);
        continue;
      }
      const entries = await this.fs.readdir(current, { limit: 1 });
      if (entries.length > 0) return;
      await this.fs.rm(current, { force: true });
      if (current === stop) return;
      current = parentPath(current);
    }
  }

  private async readManifestOrNull(path: string): Promise<DurableRepositoryManifest | null> {
    const raw = await this.readUtf8FileOrNull(path, MAX_METADATA_BYTES);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("version" in value)) {
      throw new Error("Repository workspace manifest version is missing");
    }
    return value.version === 1
      ? legacyStoredManifestSchema.parse(value)
      : storedManifestSchema.parse(value);
  }

  private async readTextFile(path: string): Promise<string> {
    const stat = await this.fs.lstat(path);
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
      return await this.fs.lstat(path);
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

async function toStoredManifest(
  materialization: PiRepositoryMaterialization
): Promise<StoredRepositoryManifest> {
  const files = await Promise.all(
    materialization.files.map(async ({ contentBase64, ...file }) => ({
      ...file,
      contentSha256: await sha256(base64ToBytes(contentBase64)),
    }))
  );
  const manifest = storedManifestSchema.parse({
    version: 2,
    repository: materialization.repository,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
  encodeStoredManifest(manifest);
  return manifest;
}

function assertSameManifest(
  existing: StoredRepositoryManifest,
  expected: StoredRepositoryManifest
) {
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error("Repository materialization does not match its durable manifest");
  }
}

function assertSameLegacyManifest(
  existing: LegacyStoredRepositoryManifest,
  expected: StoredRepositoryManifest
): void {
  const expectedLegacy: LegacyStoredRepositoryManifest = {
    version: 1,
    repository: expected.repository,
    files: expected.files
      .map(({ contentSha256: _hash, ...file }) => file)
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const canonicalExisting = {
    ...existing,
    files: [...existing.files].sort((left, right) => left.path.localeCompare(right.path)),
  };
  if (JSON.stringify(canonicalExisting) !== JSON.stringify(expectedLegacy)) {
    throw new Error("Repository materialization does not match its durable manifest");
  }
}

function encodeStoredManifest(manifest: StoredRepositoryManifest): string {
  const encoded = JSON.stringify(storedManifestSchema.parse(manifest));
  if (
    encoded.length > MAX_METADATA_BYTES ||
    new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES
  ) {
    throw new Error("Repository manifest exceeds the durable metadata limit");
  }
  return encoded;
}

function isRepositoryPath(path: string): boolean {
  return isSafeRepositoryRelativePath(path);
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function repositoryRoot(position: number): string {
  return `/workspace/repos/${position}`;
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

function modeMatches(mode: number, expected: "100644" | "100755"): boolean {
  return (mode & 0o777) === (expected === "100755" ? 0o755 : 0o644);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isBoundedAbsoluteRepositoryPath(path: string): boolean {
  return path.length <= PI_REPOSITORY_MAX_PATH_BYTES + 128;
}

function isSafeStorageRelativePath(root: string, path: string): boolean {
  if (root === "/workspace/repos") {
    const [position, ...userSegments] = path.split("/");
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(position)) return false;
    const userPath = userSegments.join("/");
    return userPath === "" || isSafeRepositoryRelativePath(userPath);
  }
  const internalMaxBytes = PI_REPOSITORY_MAX_PATH_BYTES + 512;
  const internalMaxDepth = PI_REPOSITORY_MAX_DEPTH + 8;
  if (
    path.length > internalMaxBytes ||
    path.split("/").length > internalMaxDepth ||
    new TextEncoder().encode(path).byteLength > internalMaxBytes
  ) {
    return false;
  }
  const baseline = path.match(/^repositories\/(?:0|[1-9][0-9]{0,9})\/baseline\/(.+)$/s);
  if (baseline) return isSafeRepositoryRelativePath(baseline[1]);
  const staging = path.match(/^staging\/repository-(?:0|[1-9][0-9]{0,9})\/(.+)$/s);
  return staging ? isSafeRepositoryRelativePath(staging[1]) : true;
}

function projectedMutationBytes(
  request: z.infer<typeof repositoryMutationSchema>,
  existingText: string | null
): number {
  if (request.tool === "delete") return 0;
  if (request.tool === "write")
    return new TextEncoder().encode(request.arguments.content).byteLength;
  let bytes = new TextEncoder().encode(existingText ?? "").byteLength;
  for (const edit of request.arguments.edits)
    bytes += new TextEncoder().encode(edit.newText).byteLength;
  return bytes;
}

function isErrorResult(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "isError" in value && value.isError === true
  );
}

function samePaths(stored: readonly string[], current: ReadonlySet<string>): boolean {
  return stored.length === current.size && stored.every((path) => current.has(path));
}

function projectionFromOutcome(
  outcome: "published" | "idle" | "pending" | "permanent",
  durableRetryArmed: boolean
): "published" | "pending" | "failed" {
  if (outcome === "published" || outcome === "idle") return "published";
  if (outcome === "permanent") return "failed";
  return durableRetryArmed ? "pending" : "failed";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gitBlobObjectId(bytes: Uint8Array, hexLength: number): Promise<string | null> {
  const algorithm = hexLength === 40 ? "SHA-1" : hexLength === 64 ? "SHA-256" : null;
  if (!algorithm) return null;
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + bytes.byteLength);
  input.set(header);
  input.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest(algorithm, input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
