import type { CredentialScope } from "../source-control/credential-scope";
import type { SourceControlProvider } from "../source-control";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";
import { formatRepositoryFullName } from "@open-inspect/shared/types/repositories";

const MAX_REPOSITORY_FILE_BYTES = 256 * 1024;
const MAX_REPOSITORY_TREE_ENTRIES = 500;
const DEFAULT_READ_CHARS = 50_000;

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
  provider(): Pick<SourceControlProvider, "resolveCommit" | "listTree" | "readFile">;
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

/** Replay-safe, read-only repository operations for Pi tools. */
export class PiRepositoryTools {
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
        sizeBytes: entry.sizeBytes,
        executable: entry.executable,
      })),
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
    return commit.sha;
  }

  private targetCommit(
    repository: PiRepository,
    commitSha: string | undefined,
    scope: CredentialScope
  ): Promise<string> {
    if (commitSha !== undefined) {
      const normalized = commitSha.trim();
      if (!normalized || normalized.length > 256 || hasControlCharacters(normalized)) {
        throw new Error("Repository commit is invalid");
      }
      return Promise.resolve(normalized);
    }
    return this.resolveCommit(repository, undefined, scope);
  }
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
