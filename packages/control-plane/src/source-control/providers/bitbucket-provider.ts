/**
 * Bitbucket source control provider implementation.
 *
 * Implements the SourceControlProvider interface for Bitbucket Cloud.
 */

import {
  type BuildGitPushSpecConfig,
  type BuildManualPullRequestUrlConfig,
  type CreatePullRequestConfig,
  type CreatePullRequestResult,
  type GetRepositoryConfig,
  type GitPushAuthContext,
  type GitPushSpec,
  type RepositoryInfo,
  type SourceControlAuthContext,
  type SourceControlProvider,
} from "../types";
import { SourceControlProviderError } from "../errors";
import { fetchWithTimeout } from "../../auth/github-app";
import { BITBUCKET_API_BASE, USER_AGENT } from "./constants";
import type { BitbucketProviderConfig } from "./types";

interface BitbucketRepositoryResponse {
  uuid: string;
  name: string;
  full_name: string;
  is_private: boolean;
  owner: {
    username?: string;
    nickname?: string;
    display_name?: string;
  };
  mainbranch?: {
    name?: string;
  };
}

interface BitbucketPullRequestResponse {
  id: number;
  state: string;
  draft?: boolean;
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  links?: {
    html?: { href?: string };
    self?: { href?: string };
  };
}

/**
 * Bitbucket implementation of SourceControlProvider.
 */
export class BitbucketSourceControlProvider implements SourceControlProvider {
  readonly name = "bitbucket";

  constructor(private readonly config: BitbucketProviderConfig = {}) {}

  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const response = await fetchWithTimeout(
      `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
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

    const data = (await response.json()) as BitbucketRepositoryResponse;
    const owner = data.owner.username ?? data.owner.nickname ?? config.owner;
    const defaultBranch = data.mainbranch?.name ?? "main";

    return {
      owner,
      name: data.name,
      fullName: data.full_name,
      defaultBranch,
      isPrivate: Boolean(data.is_private),
      providerRepoId: data.uuid,
    };
  }

  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const response = await fetchWithTimeout(
      `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.repository.owner)}/${encodeURIComponent(config.repository.name)}/pullrequests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          title: config.title,
          description: config.body,
          source: { branch: { name: config.sourceBranch } },
          destination: { branch: { name: config.targetBranch } },
          draft: Boolean(config.draft),
        }),
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

    const data = (await response.json()) as BitbucketPullRequestResponse;
    const webUrl = data.links?.html?.href;
    const apiUrl = data.links?.self?.href;

    if (!webUrl || !apiUrl) {
      throw new SourceControlProviderError(
        "Failed to create PR: Missing pull request links in Bitbucket response",
        "permanent"
      );
    }

    const state = this.mapPullRequestState(data.state, Boolean(data.draft));

    return {
      id: data.id,
      webUrl,
      apiUrl,
      state,
      sourceBranch: data.source?.branch?.name ?? config.sourceBranch,
      targetBranch: data.destination?.branch?.name ?? config.targetBranch,
    };
  }

  async generatePushAuth(): Promise<GitPushAuthContext> {
    if (!this.config.botAppPassword) {
      throw new SourceControlProviderError(
        "Bitbucket bot app password not configured - cannot generate push auth",
        "permanent"
      );
    }

    return {
      authType: "pat",
      token: this.config.botAppPassword,
    };
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const owner = encodeURIComponent(config.owner);
    const name = encodeURIComponent(config.name);
    const source = encodeURIComponent(config.sourceBranch);
    const target = encodeURIComponent(config.targetBranch);
    return `https://bitbucket.org/${owner}/${name}/pull-requests/new?source=${source}&dest=${target}`;
  }

  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec {
    const force = config.force ?? false;
    const username = this.config.botUsername ?? "x-token-auth";
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(config.auth.token);
    const remoteUrl = `https://${encodedUsername}:${encodedPassword}@bitbucket.org/${config.owner}/${config.name}.git`;
    const redactedRemoteUrl = `https://${encodedUsername}:<redacted>@bitbucket.org/${config.owner}/${config.name}.git`;

    return {
      remoteUrl,
      redactedRemoteUrl,
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force,
    };
  }

  private mapPullRequestState(state: string, draft: boolean): CreatePullRequestResult["state"] {
    if (draft) return "draft";

    const normalized = state.toUpperCase();
    if (normalized === "OPEN") return "open";
    if (normalized === "MERGED") return "merged";
    if (normalized === "DECLINED" || normalized === "SUPERSEDED") return "closed";
    return "open";
  }
}

/**
 * Create a Bitbucket source control provider.
 */
export function createBitbucketProvider(
  config: BitbucketProviderConfig = {}
): SourceControlProvider {
  return new BitbucketSourceControlProvider(config);
}
