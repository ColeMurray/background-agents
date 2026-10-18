import type { CredentialScope } from "../source-control/credential-scope";
import type { SourceControlProvider } from "../source-control";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";
import { formatRepositoryFullName } from "@open-inspect/shared/types/repositories";
import { requireFullGitObjectId } from "../source-control/git-object-id";
import {
  PI_REPOSITORY_MATERIALIZATION_BATCH_FILES,
  PI_REPOSITORY_MAX_BYTES,
  PI_REPOSITORY_MAX_FILE_BYTES,
  PI_REPOSITORY_MAX_FILES,
  type PiRepositoryMaterializationManifest,
} from "./session-context-contract";

const MAX_REPOSITORY_FILE_BYTES = PI_REPOSITORY_MAX_FILE_BYTES;
const MAX_REPOSITORY_TREE_ENTRIES = 500;
const DEFAULT_READ_CHARS = 50_000;
const MAX_MATERIALIZED_ENTRIES = PI_REPOSITORY_MAX_FILES;
const MAX_MATERIALIZED_BYTES = PI_REPOSITORY_MAX_BYTES;

interface PiRepository {
  repoOwner: string;
  repoName: string;
  position: number;
  baseBranch: string | null;
}

export interface PiPinnedRepository extends PiRepository {
  commitSha: string;
}

interface PiRepositoryToolsOptions {
  repositories(): readonly PiRepository[];
  resolveCredentialScope(): Promise<CredentialScope>;
  provider(): Pick<SourceControlProvider, "resolveCommit" | "listTree" | "readFile" | "readBlob">;
}

interface RepositoryTargetInput {
  repository?: number;
  commitSha?: string;
}

export interface RepositoryListInput extends RepositoryTargetInput {
  path?: string;
  offset?: number;
  limit?: number;
}

export interface RepositoryReadInput extends RepositoryTargetInput {
  path: string;
  offset?: number;
  limit?: number;
}

export type RepositoryMaterializeInput = RepositoryTargetInput;
export interface RepositoryMaterializeBatchInput extends RepositoryTargetInput {
  offset: number;
}

/** Replay-safe, read-only repository operations for Pi tools. */
export class PiRepositoryTools {
  private readonly materializationManifests = new Map<
    string,
    PiRepositoryMaterializationManifest
  >();

  constructor(private readonly options: PiRepositoryToolsOptions) {}

  async pin(): Promise<PiPinnedRepository[]> {
    const repositories = this.options.repositories();
    if (repositories.length === 0) return [];
    const scope = await this.options.resolveCredentialScope();
    return Promise.all(
      repositories.map(async (repository) => ({
        ...repository,
        commitSha: await this.resolveCommit(repository, undefined, scope),
      }))
    );
  }

  /** Reattach the session's first durable pins without resolving mutable refs again. */
  restore(
    pins: readonly Pick<PiPinnedRepository, "repoOwner" | "repoName" | "position" | "commitSha">[]
  ): PiPinnedRepository[] {
    const repositories = this.options.repositories();
    const byPosition = new Map(pins.map((pin) => [pin.position, pin]));
    if (pins.length !== repositories.length || byPosition.size !== pins.length) {
      throw new Error("Pi repository pins do not match the session repository set");
    }
    return repositories.map((repository) => {
      const pin = byPosition.get(repository.position);
      const commitSha = pin?.commitSha.trim() ?? "";
      if (
        !pin ||
        pin.repoOwner !== repository.repoOwner ||
        pin.repoName !== repository.repoName ||
        !commitSha ||
        hasControlCharacters(commitSha)
      ) {
        throw new Error("Pi repository pin does not match the session repository set");
      }
      return { ...repository, commitSha: requireFullGitObjectId(commitSha) };
    });
  }

  async list(input: RepositoryListInput) {
    const repository = this.repository(input.repository);
    const path = repositoryPath(input.path ?? "", true);
    const scope = await this.options.resolveCredentialScope();
    const commitSha = await this.targetCommit(repository, input.commitSha, scope);
    const tree = await this.options.provider().listTree(
      {
        owner: repository.repoOwner,
        name: repository.repoName,
        commitSha,
        path: path || null,
      },
      scope
    );
    if (tree.truncated) {
      throw new Error("The repository tree is truncated; narrow the requested path");
    }
    const offset = boundedInteger(input.offset, 0, tree.entries.length, 0);
    const limit = boundedInteger(
      input.limit,
      1,
      MAX_REPOSITORY_TREE_ENTRIES,
      MAX_REPOSITORY_TREE_ENTRIES
    );
    const end = Math.min(tree.entries.length, offset + limit);
    const truncated = end < tree.entries.length;
    return {
      repository: formatRepositoryFullName(repository),
      commitSha,
      path,
      truncated,
      nextOffset: truncated ? end : null,
      entries: tree.entries.slice(offset, end).map((entry) => ({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        sizeBytes: entry.sizeBytes,
        executable: entry.executable,
      })),
    };
  }

  /** Build an exact, credential-free repository payload for Pi's durable VFS. */
  async prepareMaterialization(
    input: RepositoryMaterializeInput
  ): Promise<PiRepositoryMaterializationManifest> {
    const repository = this.repository(input.repository);
    const scope = await this.options.resolveCredentialScope();
    const commitSha = await this.targetCommit(repository, input.commitSha, scope);
    const tree = await this.options.provider().listTree(
      {
        owner: repository.repoOwner,
        name: repository.repoName,
        commitSha,
        path: null,
        maxEntries: MAX_MATERIALIZED_ENTRIES,
      },
      scope
    );
    if (tree.truncated) {
      throw new Error("The repository tree is truncated and cannot be materialized exactly");
    }

    if (tree.entries.length > MAX_MATERIALIZED_ENTRIES) {
      throw new Error(
        `Repository exceeds the ${MAX_MATERIALIZED_ENTRIES} entry materialization limit`
      );
    }
    const files = tree.entries.filter((entry) => entry.type === "file");
    const paths = new Set<string>();
    let declaredBytes = 0;
    for (const entry of tree.entries) {
      repositoryPath(entry.path, false);
      if (paths.has(entry.path))
        throw new Error(`Repository tree has a duplicate path: ${entry.path}`);
      paths.add(entry.path);
      if (entry.type === "directory" && entry.mode === "040000") continue;
      if (entry.type !== "file" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        throw new Error(
          `Repository path has an unsupported Git mode: ${entry.path} (${entry.mode})`
        );
      }
      if (entry.sizeBytes !== null) {
        if (entry.sizeBytes > MAX_REPOSITORY_FILE_BYTES) {
          throw new Error(
            `Repository file exceeds ${MAX_REPOSITORY_FILE_BYTES} bytes: ${entry.path}`
          );
        }
        declaredBytes += entry.sizeBytes;
      }
    }
    if (declaredBytes > MAX_MATERIALIZED_BYTES) {
      throw new Error(
        `Repository exceeds the ${MAX_MATERIALIZED_BYTES} byte materialization limit`
      );
    }

    const manifest = {
      version: 1 as const,
      repository: {
        position: repository.position,
        repoOwner: repository.repoOwner,
        repoName: repository.repoName,
        commitSha,
        root: `/workspace/repos/${repository.position}`,
      },
      files: files.map((entry) => ({
        path: entry.path,
        blobId: entry.blobId,
        mode: entry.mode as "100644" | "100755",
        sizeBytes: entry.sizeBytes,
      })),
    };
    this.materializationManifests.set(
      this.materializationKey(repository.position, commitSha),
      manifest
    );
    return manifest;
  }

  async materializeBatch(input: RepositoryMaterializeBatchInput) {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new Error("Materialization offset must be a non-negative integer");
    }
    const repository = this.repository(input.repository);
    const scope = await this.options.resolveCredentialScope();
    const commitSha = await this.targetCommit(repository, input.commitSha, scope);
    const key = this.materializationKey(repository.position, commitSha);
    const manifest =
      this.materializationManifests.get(key) ??
      (await this.prepareMaterialization({ repository: repository.position, commitSha }));
    const selected = manifest.files.slice(
      input.offset,
      input.offset + PI_REPOSITORY_MATERIALIZATION_BATCH_FILES
    );
    let batchBytes = 0;
    const materializedFiles = [];
    for (const entry of selected) {
      const bytes = await this.options.provider().readBlob(
        {
          owner: repository.repoOwner,
          name: repository.repoName,
          blobId: entry.blobId,
          maxBytes: MAX_REPOSITORY_FILE_BYTES,
        },
        scope
      );
      if (bytes.byteLength > MAX_REPOSITORY_FILE_BYTES) {
        throw new Error(
          `Repository file exceeds ${MAX_REPOSITORY_FILE_BYTES} bytes: ${entry.path}`
        );
      }
      if (entry.sizeBytes !== null && bytes.byteLength !== entry.sizeBytes) {
        throw new Error(`Repository file size does not match its tree entry: ${entry.path}`);
      }
      batchBytes += bytes.byteLength;
      if (batchBytes > MAX_MATERIALIZED_BYTES) {
        throw new Error(
          `Repository materialization batch exceeds the ${MAX_MATERIALIZED_BYTES} byte limit`
        );
      }
      materializedFiles.push({
        path: entry.path,
        blobId: entry.blobId,
        mode: entry.mode,
        sizeBytes: bytes.byteLength,
        contentBase64: bytesToBase64(bytes),
      });
    }

    const nextOffset = input.offset + selected.length;
    return {
      version: 1 as const,
      repository: manifest.repository,
      offset: input.offset,
      nextOffset: nextOffset < manifest.files.length ? nextOffset : null,
      files: materializedFiles,
    };
  }

  async read(input: RepositoryReadInput) {
    const repository = this.repository(input.repository);
    const path = repositoryPath(input.path, false);
    const scope = await this.options.resolveCredentialScope();
    const commitSha = await this.targetCommit(repository, input.commitSha, scope);
    const bytes = await this.options.provider().readFile(
      {
        owner: repository.repoOwner,
        name: repository.repoName,
        commitSha,
        path,
        maxBytes: MAX_REPOSITORY_FILE_BYTES,
      },
      scope
    );
    if (!bytes) throw new Error(`Repository file not found: ${path}`);
    if (bytes.byteLength > MAX_REPOSITORY_FILE_BYTES) {
      throw new Error(`Repository file exceeds ${MAX_REPOSITORY_FILE_BYTES} bytes`);
    }
    if (bytes.includes(0)) throw new Error(`Repository file is not UTF-8 text: ${path}`);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new Error(`Repository file is not UTF-8 text: ${path}`);
    }
    const start = boundedInteger(input.offset, 0, content.length, 0);
    const limit = boundedInteger(input.limit, 1, DEFAULT_READ_CHARS, DEFAULT_READ_CHARS);
    const end = Math.min(content.length, start + limit);
    return {
      repository: formatRepositoryFullName(repository),
      commitSha,
      path,
      content: content.slice(start, end),
      start,
      end,
      totalBytes: bytes.byteLength,
      truncated: end < content.length,
    };
  }

  private repository(index = 0): PiRepository {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error("Repository index must be a non-negative integer");
    }
    const repository = this.options
      .repositories()
      .find((candidate) => candidate.position === index);
    if (!repository) throw new Error(`Repository index ${index} is not part of this session`);
    return repository;
  }

  private async resolveCommit(
    repository: PiRepository,
    requestedRef: string | undefined,
    scope: CredentialScope
  ): Promise<string> {
    const ref = requestedRef?.trim() || repository.baseBranch || DEFAULT_BASE_BRANCH;
    if (ref.length > 256 || hasControlCharacters(ref)) {
      throw new Error("Repository ref is invalid");
    }
    const commit = await this.options
      .provider()
      .resolveCommit({ owner: repository.repoOwner, name: repository.repoName, ref }, scope);
    if (!commit) throw new Error(`Repository ref not found: ${ref}`);
    return requireFullGitObjectId(commit.sha);
  }

  private targetCommit(
    repository: PiRepository,
    commitSha: string | undefined,
    scope: CredentialScope
  ): Promise<string> {
    if (commitSha !== undefined) {
      const normalized = commitSha.trim();
      if (!normalized || hasControlCharacters(normalized)) {
        throw new Error("Repository commit is invalid");
      }
      return Promise.resolve(requireFullGitObjectId(normalized));
    }
    return this.resolveCommit(repository, undefined, scope);
  }

  private materializationKey(position: number, commitSha: string): string {
    return `${position}:${commitSha.toLowerCase()}`;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function repositoryPath(value: string, allowEmpty: boolean): string {
  const path = value.trim();
  if (allowEmpty && path === "") return "";
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    hasControlCharacters(path)
  ) {
    throw new Error("Path must be a repository-relative POSIX path");
  }
  return path;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Value must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
