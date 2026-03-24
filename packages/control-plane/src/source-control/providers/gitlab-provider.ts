/**
 * GitLab source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitLab.com
 * using Personal Access Tokens (PAT) for authentication.
 */

import type { InstallationRepository } from "@open-inspect/shared";
import type {
  SourceControlProvider,
  SourceControlAuthContext,
  GetRepositoryConfig,
  RepositoryAccessResult,
  RepositoryInfo,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  GitPushAuthContext,
} from "../types";
import { SourceControlProviderError } from "../errors";
import type { GitLabProviderConfig } from "./types";
import { USER_AGENT } from "./constants";

/** GitLab API base URL. */
export const GITLAB_API_BASE = "https://gitlab.com/api/v4";

/** Default per_page for paginated GitLab API requests. */
const PER_PAGE = 100;

/** Timeout for GitLab API requests in milliseconds. */
const GITLAB_FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITLAB_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** URL-encode a project path (owner/name → owner%2Fname). */
function encodeProjectPath(owner: string, name: string): string {
  return encodeURIComponent(`${owner}/${name}`);
}

/**
 * GitLab implementation of SourceControlProvider.
 *
 * Uses Personal Access Tokens for all API calls. The PAT must have
 * `read_api` scope for read operations and `api` scope for write operations
 * (creating merge requests, push).
 */
export class GitLabSourceControlProvider implements SourceControlProvider {
  readonly name = "gitlab";

  private readonly accessToken: string;
  private readonly namespace?: string;

  constructor(config: GitLabProviderConfig) {
    this.accessToken = config.accessToken;
    this.namespace = config.namespace;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
  }

  /**
   * Get repository (project) information from GitLab API.
   */
  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const projectPath = encodeProjectPath(config.owner, config.name);
    const response = await fetchWithTimeout(`${GITLAB_API_BASE}/projects/${projectPath}`, {
      headers: this.headers(auth.token),
    });

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get repository: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = (await response.json()) as {
      id: number;
      name: string;
      path_with_namespace: string;
      namespace: { path: string };
      default_branch: string;
      visibility: string;
    };

    return {
      owner: data.namespace.path,
      name: data.name,
      fullName: data.path_with_namespace,
      defaultBranch: data.default_branch,
      isPrivate: data.visibility !== "public",
      providerRepoId: data.id,
    };
  }

  /**
   * Create a merge request on GitLab.
   */
  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const projectPath = encodeProjectPath(config.repository.owner, config.repository.name);

    const requestBody: Record<string, unknown> = {
      title: config.title,
      description: config.body,
      source_branch: config.sourceBranch,
      target_branch: config.targetBranch,
    };

    if (config.draft) {
      // GitLab supports draft MRs via title prefix "Draft: "
      requestBody.title = `Draft: ${config.title}`;
    }

    if (config.reviewers && config.reviewers.length > 0) {
      // GitLab accepts reviewer_ids, but we only have usernames here — skip silently
      // to avoid an extra API call to resolve usernames → IDs
    }

    if (config.labels && config.labels.length > 0) {
      requestBody.labels = config.labels.join(",");
    }

    const response = await fetchWithTimeout(
      `${GITLAB_API_BASE}/projects/${projectPath}/merge_requests`,
      {
        method: "POST",
        headers: this.headers(auth.token),
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to create merge request: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = (await response.json()) as {
      iid: number;
      web_url: string;
      _links: { self: string };
      state: string;
      draft: boolean;
      source_branch: string;
      target_branch: string;
    };

    let state: CreatePullRequestResult["state"];
    if (data.draft) {
      state = "draft";
    } else if (data.state === "merged") {
      state = "merged";
    } else if (data.state === "opened") {
      state = "open";
    } else if (data.state === "closed") {
      state = "closed";
    } else {
      state = "open";
    }

    return {
      id: data.iid,
      webUrl: data.web_url,
      apiUrl: data._links.self,
      state,
      sourceBranch: data.source_branch,
      targetBranch: data.target_branch,
    };
  }

  /**
   * Check whether a specific repository is accessible using the provider's PAT.
   */
  async checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null> {
    const projectPath = encodeProjectPath(config.owner, config.name);

    try {
      const response = await fetchWithTimeout(`${GITLAB_API_BASE}/projects/${projectPath}`, {
        headers: this.headers(this.accessToken),
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const error = await response.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to check repository access: ${response.status} ${error}`,
          new Error(error),
          response.status
        );
      }

      const data = (await response.json()) as {
        id: number;
        namespace: { path: string };
        path: string;
        default_branch: string;
      };

      return {
        repoId: data.id,
        repoOwner: data.namespace.path.toLowerCase(),
        repoName: data.path.toLowerCase(),
        defaultBranch: data.default_branch,
      };
    } catch (error) {
      if (error instanceof SourceControlProviderError) {
        throw error;
      }
      throw SourceControlProviderError.fromFetchError(
        `Failed to check repository access: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * List all projects accessible to the PAT.
   *
   * If a namespace is configured, lists projects within that group.
   * Otherwise lists all projects the PAT has access to.
   */
  async listRepositories(): Promise<InstallationRepository[]> {
    try {
      const url = this.namespace
        ? `${GITLAB_API_BASE}/groups/${encodeURIComponent(this.namespace)}/projects?per_page=${PER_PAGE}&include_subgroups=true`
        : `${GITLAB_API_BASE}/projects?membership=true&per_page=${PER_PAGE}`;

      const response = await fetchWithTimeout(url, {
        headers: this.headers(this.accessToken),
      });

      if (!response.ok) {
        const error = await response.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to list repositories: ${response.status} ${error}`,
          new Error(error),
          response.status
        );
      }

      const data = (await response.json()) as Array<{
        id: number;
        name: string;
        path: string;
        path_with_namespace: string;
        namespace: { path: string };
        description: string | null;
        visibility: string;
        default_branch: string;
      }>;

      return data.map((project) => ({
        id: project.id,
        owner: project.namespace.path,
        name: project.path,
        fullName: project.path_with_namespace,
        description: project.description,
        private: project.visibility !== "public",
        defaultBranch: project.default_branch,
      }));
    } catch (error) {
      if (error instanceof SourceControlProviderError) {
        throw error;
      }
      throw SourceControlProviderError.fromFetchError(
        `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * List branches for a repository.
   */
  async listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]> {
    const projectPath = encodeProjectPath(config.owner, config.name);

    try {
      const response = await fetchWithTimeout(
        `${GITLAB_API_BASE}/projects/${projectPath}/repository/branches?per_page=${PER_PAGE}`,
        { headers: this.headers(this.accessToken) }
      );

      if (!response.ok) {
        const error = await response.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to list branches: ${response.status} ${error}`,
          new Error(error),
          response.status
        );
      }

      const data = (await response.json()) as Array<{ name: string }>;
      return data.map((b) => ({ name: b.name }));
    } catch (error) {
      if (error instanceof SourceControlProviderError) {
        throw error;
      }
      throw SourceControlProviderError.fromFetchError(
        `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Generate authentication for git push operations using the provider PAT.
   */
  async generatePushAuth(): Promise<GitPushAuthContext> {
    return {
      authType: "pat",
      token: this.accessToken,
    };
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const encodedOwner = encodeURIComponent(config.owner);
    const encodedName = encodeURIComponent(config.name);
    const encodedSource = encodeURIComponent(config.sourceBranch);
    const encodedTarget = encodeURIComponent(config.targetBranch);
    return (
      `https://gitlab.com/${encodedOwner}/${encodedName}/-/merge_requests/new` +
      `?merge_request[source_branch]=${encodedSource}` +
      `&merge_request[target_branch]=${encodedTarget}`
    );
  }

  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec {
    const force = config.force ?? false;
    const remoteUrl = `https://oauth2:${config.auth.token}@gitlab.com/${config.owner}/${config.name}.git`;
    const redactedRemoteUrl = `https://oauth2:<redacted>@gitlab.com/${config.owner}/${config.name}.git`;

    return {
      remoteUrl,
      redactedRemoteUrl,
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force,
    };
  }
}

/**
 * Create a GitLab source control provider.
 */
export function createGitLabProvider(config: GitLabProviderConfig): SourceControlProvider {
  return new GitLabSourceControlProvider(config);
}
