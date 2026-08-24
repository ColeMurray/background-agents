/**
 * GitHub source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitHub,
 * wrapping existing GitHub API functions.
 */

import { z } from "zod";
import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import type { PullRequestStatus } from "@open-inspect/shared/types/artifacts";
import type {
  SourceControlProvider,
  SourceControlAuthContext,
  GetRepositoryConfig,
  RepositoryAccessResult,
  RepositoryInfo,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  GetPullRequestConfig,
  PullRequestSnapshot,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  GitPushAuthContext,
  CredentialHelperAuth,
  ResolvedCommit,
  RepositoryTree,
} from "../types";
import {
  readResponseBytesWithinLimit,
  SourceControlProviderError,
  parseProviderResponse,
} from "../errors";
import { classifyGitTreeEntry } from "./git-tree";
import {
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationRepository,
  listInstallationRepositories,
  listRepositoryBranches,
  fetchWithTimeout,
} from "../../auth/github-app";
import type { GitHubProviderConfig } from "./types";
import { USER_AGENT, GITHUB_API_BASE } from "./constants";

/** Extract HTTP status from upstream errors (GitHubHttpError has a .status property). */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

/** GitHub pull-request state fields as the REST API reports them. */
interface GitHubPullRequestStateFields {
  /** GitHub's wire state is strictly open/closed; merged is a separate flag. */
  state: "open" | "closed";
  draft?: boolean | null;
  merged?: boolean | null;
}

/**
 * Pure mapping from GitHub's PR state fields to the stored status. GitHub
 * models merged as state "closed" + merged true; terminal states win over a
 * stale draft flag (isDraft is only meaningful while open). Shared by
 * createPullRequest (user-authed) and getPullRequest (app-authed).
 */
export function deriveGitHubPullRequestStatus(
  data: GitHubPullRequestStateFields
): PullRequestStatus {
  if (data.merged) return { lifecycleState: "merged", isDraft: false };
  if (data.state === "closed") return { lifecycleState: "closed", isDraft: false };
  return { lifecycleState: "open", isDraft: data.draft === true };
}

/**
 * Wire schema of a GitHub REST pull request, limited to the fields we read.
 * `state` is a strict enum — an unexpected value is schema drift and fails
 * the parse rather than being coerced into an apparently-valid status.
 */
const githubPullResponseSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable().optional(),
  merged: z.boolean().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }),
  base: z.object({
    ref: z.string(),
    repo: z
      .object({
        id: z.number().optional(),
        name: z.string().optional(),
        owner: z.object({ login: z.string().optional() }).optional(),
      })
      .nullable()
      .optional(),
  }),
});

/** Wire shape of GET /repositories/{id}, limited to the location fields. */
const githubRepositoryLocationSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

/** Wire shape of GET /repos/{owner}/{repo}, limited to fields used for repo metadata. */
const githubRepositoryInfoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  owner: z.object({ login: z.string() }),
});

/** Wire shape of a GitHub git-ref response, limited to the branch head SHA. */
const githubBranchRefSchema = z.object({
  object: z.object({ sha: z.string().min(1) }),
});

/** Wire shape of GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1. */
const githubTreeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().int().nonnegative().optional(),
    })
  ),
});

/** Build a classified provider error from a non-OK GitHub response. */
async function githubResponseError(
  response: Response,
  operation: string
): Promise<SourceControlProviderError> {
  const body = await response.text();
  return SourceControlProviderError.fromFetchError(
    `Failed to ${operation}: ${response.status} ${body}`,
    new Error(body),
    response.status
  );
}

/** Parse a GitHub ISO-8601 timestamp into epoch ms; undefined when absent/invalid. */
function parseProviderTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * GitHub implementation of SourceControlProvider.
 */
export class GitHubSourceControlProvider implements SourceControlProvider {
  readonly name = "github";

  private readonly appConfig?: GitHubProviderConfig["appConfig"];
  private readonly cacheStore?: GitHubProviderConfig["cacheStore"];
  private readonly userAgent: string;

  constructor(config: GitHubProviderConfig = {}) {
    this.appConfig = config.appConfig;
    this.cacheStore = config.cacheStore;
    this.userAgent = config.userAgent || USER_AGENT;
  }

  /**
   * Get repository information from GitHub API.
   */
  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": this.userAgent,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get repository: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubRepositoryInfoSchema,
      "Failed to get repository"
    );

    return {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      providerRepoId: data.id,
    };
  }

  /**
   * Create a pull request on GitHub.
   */
  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const requestBody: Record<string, unknown> = {
      title: config.title,
      body: config.body,
      head: config.sourceBranch,
      base: config.targetBranch,
    };

    // Add draft flag if requested and supported
    if (config.draft) {
      requestBody.draft = true;
    }

    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.repository.owner}/${config.repository.name}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": this.userAgent,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to create PR: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubPullResponseSchema,
      "Failed to create PR"
    );

    const repositoryExternalId = data.base.repo?.id;
    const status = deriveGitHubPullRequestStatus(data);
    const result: CreatePullRequestResult = {
      id: data.number,
      webUrl: data.html_url,
      apiUrl: data.url,
      lifecycleState: status.lifecycleState,
      isDraft: status.isDraft,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      headSha: data.head.sha,
      repositoryExternalId:
        repositoryExternalId !== undefined ? String(repositoryExternalId) : undefined,
      providerUpdatedAt: parseProviderTimestamp(data.updated_at),
    };

    // Add labels if requested
    if (config.labels && config.labels.length > 0) {
      await this.ensureLabels(
        auth.token,
        config.repository.owner,
        config.repository.name,
        config.labels
      );
      await this.addLabels(
        auth.token,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.labels
      );
    }

    // Request reviewers if requested
    if (config.reviewers && config.reviewers.length > 0) {
      await this.requestReviewers(
        auth.token,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.reviewers
      );
    }

    return result;
  }

  /**
   * Read the current state of a pull request using GitHub App credentials.
   *
   * On a 404 with a known stable repo id, re-resolves the repository's
   * current owner/name by id and retries once (rename/transfer tolerance).
   */
  async getPullRequest(config: GetPullRequestConfig): Promise<PullRequestSnapshot> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot get pull request",
        "permanent"
      );
    }

    let token: string;
    try {
      token = await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }

    let response = await this.fetchPullRequest(token, config.owner, config.name, config.number);

    if (response.status === 404 && config.repositoryExternalId) {
      const resolved = await this.resolveRepositoryLocationById(token, config.repositoryExternalId);
      if (resolved) {
        response = await this.fetchPullRequest(token, resolved.owner, resolved.name, config.number);
      }
    }

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get pull request: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubPullResponseSchema,
      "Failed to get pull request"
    );
    const status = deriveGitHubPullRequestStatus(data);
    const repositoryExternalId = data.base.repo?.id;

    return {
      number: data.number,
      url: data.html_url,
      lifecycleState: status.lifecycleState,
      isDraft: status.isDraft,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      headSha: data.head.sha,
      // The response's base repo is authoritative for the current location.
      repoOwner: data.base.repo?.owner?.login ?? config.owner,
      repoName: data.base.repo?.name ?? config.name,
      repositoryExternalId:
        repositoryExternalId !== undefined
          ? String(repositoryExternalId)
          : config.repositoryExternalId,
      providerCreatedAt: parseProviderTimestamp(data.created_at),
      providerUpdatedAt: parseProviderTimestamp(data.updated_at),
      mergedAt: parseProviderTimestamp(data.merged_at),
      closedAt: parseProviderTimestamp(data.closed_at),
    };
  }

  private fetchPullRequest(
    token: string,
    owner: string,
    name: string,
    number: number
  ): Promise<Response> {
    return fetchWithTimeout(`${GITHUB_API_BASE}/repos/${owner}/${name}/pulls/${number}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      },
    });
  }

  /**
   * Resolve a repository's current owner/name from its stable numeric id.
   *
   * GET /repositories/{id} is GitHub's stable-but-undocumented by-id alias of
   * GET /repos/{owner}/{name} (identical response schema; acknowledged by
   * GitHub staff). Acceptable here because this is a best-effort repair path:
   * if the endpoint ever disappears, resolution degrades to "not resolved"
   * and the caller surfaces the original 404.
   */
  private async resolveRepositoryLocationById(
    token: string,
    repositoryExternalId: string
  ): Promise<{ owner: string; name: string } | null> {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repositories/${encodeURIComponent(repositoryExternalId)}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    // Best-effort repair path: a malformed resolution body degrades to "not
    // resolved" so the caller surfaces the original 404 instead.
    const parsed = githubRepositoryLocationSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success) {
      return null;
    }
    return { owner: parsed.data.owner.login, name: parsed.data.name };
  }

  /**
   * Check whether a repository is accessible to the GitHub App installation.
   */
  async checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot check repository access",
        "permanent"
      );
    }

    try {
      const repo = await getInstallationRepository(this.appConfig, config.owner, config.name, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      if (!repo) {
        return null;
      }
      if (repo.archived) {
        return null;
      }
      return {
        repoId: repo.id,
        repoOwner: repo.owner.toLowerCase(),
        repoName: repo.name.toLowerCase(),
        defaultBranch: repo.defaultBranch,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to check repository access: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * List all repositories accessible to the GitHub App installation.
   */
  async listRepositories(): Promise<InstallationRepository[]> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list repositories",
        "permanent"
      );
    }

    try {
      const result = await listInstallationRepositories(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      return result.repos.filter((repo) => !repo.archived);
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * List branches for a repository.
   */
  async listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list branches",
        "permanent"
      );
    }

    try {
      return await listRepositoryBranches(this.appConfig, config.owner, config.name, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  async getBranchHead(config: GetRepositoryConfig & { branch: string }): Promise<string | null> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot resolve branch head",
        "permanent"
      );
    }
    try {
      const token = await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
          config.name
        )}/git/ref/heads/${encodeURIComponent(config.branch)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
        }
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        const error = await response.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to resolve branch head: ${response.status} ${error}`,
          new Error(error),
          response.status
        );
      }
      const data = await parseProviderResponse(
        response,
        githubBranchRefSchema,
        "Failed to resolve branch head"
      );
      return data.object.sha;
    } catch (error) {
      if (error instanceof SourceControlProviderError) throw error;
      throw SourceControlProviderError.fromFetchError(
        `Failed to resolve branch head: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  async resolveCommit(
    config: GetRepositoryConfig & { ref: string }
  ): Promise<ResolvedCommit | null> {
    try {
      const response = await this.appFetch(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
          config.name
        )}/commits/${encodeURIComponent(config.ref)}`,
        "resolve commit",
        "application/vnd.github.sha"
      );
      if (response.status === 404) return null;
      if (!response.ok) throw await githubResponseError(response, "resolve commit");
      const sha = (await response.text()).trim();
      if (!sha) throw new Error("GitHub returned an empty commit SHA");
      return { sha };
    } catch (error) {
      if (error instanceof SourceControlProviderError) throw error;
      throw SourceControlProviderError.fromFetchError(
        `Failed to resolve commit: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  async listTree(
    config: GetRepositoryConfig & { commitSha: string; path?: string | null }
  ): Promise<RepositoryTree> {
    const scopedPath = config.path?.trim() || null;
    let treeSha = config.commitSha;
    if (scopedPath) {
      for (const segment of scopedPath.split("/")) {
        const parent = await this.appJsonRequired(
          `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
            config.name
          )}/git/trees/${encodeURIComponent(treeSha)}`,
          githubTreeSchema,
          "resolve repository subtree"
        );
        const child = parent.tree.find((entry) => entry.path === segment && entry.type === "tree");
        if (!child) return { entries: [], truncated: false };
        treeSha = child.sha;
      }
    }
    const data = await this.appJsonRequired(
      `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
        config.name
      )}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      githubTreeSchema,
      "list repository tree"
    );
    const prefix = scopedPath ? `${scopedPath}/` : "";
    return {
      truncated: data.truncated === true,
      // GitHub reports blob sizes in the tree, so callers get a usable
      // pre-download budget check from listTree alone.
      entries: data.tree.map((entry) => ({
        path: `${prefix}${entry.path}`,
        type: classifyGitTreeEntry(entry.type, entry.mode),
        blobId: entry.sha,
        sizeBytes: entry.size ?? null,
        executable: entry.mode === "100755",
      })),
    };
  }

  async readBlob(
    config: GetRepositoryConfig & { blobId: string; maxBytes: number }
  ): Promise<Uint8Array> {
    try {
      const response = await this.appFetch(
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
          config.name
        )}/git/blobs/${encodeURIComponent(config.blobId)}`,
        "read blob",
        "application/vnd.github.raw"
      );
      if (!response.ok) throw await githubResponseError(response, "read blob");
      return await readResponseBytesWithinLimit(response, config.maxBytes, config.blobId);
    } catch (error) {
      if (error instanceof SourceControlProviderError) throw error;
      throw SourceControlProviderError.fromFetchError(
        `Failed to read blob: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /** Issue an installation-authenticated GitHub API request. */
  private async appFetch(path: string, operation: string, accept: string): Promise<Response> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        `GitHub App not configured - cannot ${operation}`,
        "permanent"
      );
    }
    const token = await getCachedInstallationToken(this.appConfig, {
      cacheStore: this.cacheStore,
      userAgent: this.userAgent,
    });
    return fetchWithTimeout(`${GITHUB_API_BASE}${path}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      },
    });
  }

  /**
   * Installation-authenticated GET returning parsed JSON. A confirmed 404 is
   * absence only when the caller asks for it; otherwise it is an error.
   */
  private async appJson<T>(
    path: string,
    schema: z.ZodType<T>,
    operation: string,
    notFoundIsAbsence: boolean
  ): Promise<T | null> {
    try {
      const response = await this.appFetch(path, operation, "application/vnd.github+json");
      if (notFoundIsAbsence && response.status === 404) return null;
      if (!response.ok) throw await githubResponseError(response, operation);
      return await parseProviderResponse(response, schema, `Failed to ${operation}`);
    } catch (error) {
      if (error instanceof SourceControlProviderError) throw error;
      throw SourceControlProviderError.fromFetchError(
        `Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  private async appJsonRequired<T>(
    path: string,
    schema: z.ZodType<T>,
    operation: string
  ): Promise<T> {
    const data = await this.appJson(path, schema, operation, false);
    if (data === null) throw new SourceControlProviderError(`Failed to ${operation}`, "permanent");
    return data;
  }

  /**
   * Generate authentication for git push operations using GitHub App.
   */
  async generatePushAuth(): Promise<GitPushAuthContext> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate push auth",
        "permanent"
      );
    }

    try {
      const token = await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      return {
        authType: "app",
        token,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async generateCredentialHelperAuth(): Promise<CredentialHelperAuth> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate credential helper auth",
        "permanent"
      );
    }

    try {
      const { token, expiresAtEpochMs } = await getCachedInstallationTokenWithExpiry(
        this.appConfig,
        {
          cacheStore: this.cacheStore,
          userAgent: this.userAgent,
        }
      );
      return {
        username: "x-access-token",
        password: token,
        expiresAtEpochMs,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub credential helper auth: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const encodedOwner = encodeURIComponent(config.owner);
    const encodedName = encodeURIComponent(config.name);
    const encodedBase = encodeURIComponent(config.targetBranch);
    const encodedHead = encodeURIComponent(config.sourceBranch);
    return `https://github.com/${encodedOwner}/${encodedName}/pull/new/${encodedBase}...${encodedHead}`;
  }

  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec {
    const force = config.force ?? false;
    const remoteUrl = `https://x-access-token:${config.auth.token}@github.com/${config.owner}/${config.name}.git`;
    const redactedRemoteUrl = `https://x-access-token:<redacted>@github.com/${config.owner}/${config.name}.git`;

    return {
      remoteUrl,
      redactedRemoteUrl,
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      repoOwner: config.owner,
      repoName: config.name,
      force,
    };
  }

  /** Ensure requested labels exist without generating repeated mutating 422 responses. */
  private async ensureLabels(
    accessToken: string,
    owner: string,
    repo: string,
    labels: string[]
  ): Promise<void> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const headers = {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": this.userAgent,
    };

    for (const label of labels) {
      const labelUrl = `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/labels/${encodeURIComponent(label)}`;
      try {
        const existing = await fetchWithTimeout(labelUrl, { headers });
        if (existing.ok) continue;
        if (existing.status !== 404) {
          console.warn(`Failed to check label "${label}" in ${owner}/${repo}: ${existing.status}`);
          continue;
        }

        const created = await fetchWithTimeout(
          `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/labels`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ name: label, color: "ededed" }),
          }
        );
        if (created.ok) continue;

        // A concurrent creator can win between the GET and POST. Confirm the
        // label now exists rather than treating every validation failure as a duplicate.
        if (created.status === 422) {
          const raced = await fetchWithTimeout(labelUrl, { headers });
          if (raced.ok) continue;
        }

        console.warn(`Failed to create label "${label}" in ${owner}/${repo}: ${created.status}`);
      } catch (error) {
        console.warn(`Failed to ensure label "${label}" in ${owner}/${repo}:`, error);
      }
    }
  }

  /**
   * Add labels to a pull request.
   * This is a best-effort operation - failures are logged but don't fail the PR creation.
   */
  private async addLabels(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[]
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/labels`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": this.userAgent,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ labels }),
        }
      );

      if (!response.ok) {
        // Log but don't throw - labels are best-effort
        console.warn(`Failed to add labels to PR #${prNumber}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to add labels to PR #${prNumber}:`, error);
    }
  }

  /**
   * Request reviewers for a pull request.
   * This is a best-effort operation - failures are logged but don't fail the PR creation.
   */
  private async requestReviewers(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[]
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": this.userAgent,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reviewers }),
        }
      );

      if (!response.ok) {
        // Log but don't throw - reviewers are best-effort
        console.warn(`Failed to request reviewers for PR #${prNumber}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to request reviewers for PR #${prNumber}:`, error);
    }
  }
}

/**
 * Create a GitHub source control provider.
 *
 * @param config - Provider configuration (optional)
 * @returns GitHub source control provider instance
 */
export function createGitHubProvider(config: GitHubProviderConfig = {}): SourceControlProvider {
  return new GitHubSourceControlProvider(config);
}
