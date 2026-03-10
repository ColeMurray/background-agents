import type { InstallationRepository } from "@open-inspect/shared";
import type {
  BuildGitPushSpecConfig,
  BuildManualPullRequestUrlConfig,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  GetBranchHeadShaConfig,
  GetRepositoryConfig,
  GitPushAuthContext,
  GitPushSpec,
  RepositoryAccessResult,
  RepositoryInfo,
  SourceControlAuthContext,
  SourceControlProvider,
} from "../types";
import { SourceControlProviderError } from "../errors";
import { getBitbucketClientCredentialsToken } from "../../auth";
import type { BitbucketProviderConfig } from "./types";
import { buildTokenGitPushSpec, toSourceControlProviderError } from "./helpers";

const BITBUCKET_API_BASE = "https://api.bitbucket.org/2.0";

interface BitbucketRepositoryResponse {
  uuid: string;
  name: string;
  full_name: string;
  is_private: boolean;
  mainbranch?: {
    name?: string;
  };
  workspace?: {
    slug?: string;
  };
  description?: string | null;
}

function normalizeRepoId(uuid: string): string {
  return uuid.replace(/^\{/, "").replace(/\}$/, "");
}

export class BitbucketSourceControlProvider implements SourceControlProvider {
  readonly name = "bitbucket";

  constructor(private readonly config: BitbucketProviderConfig = {}) {}

  private requireWorkspace(): string {
    const workspace = this.config.workspace?.trim();
    if (!workspace) {
      throw new SourceControlProviderError(
        "Bitbucket workspace not configured",
        "permanent"
      );
    }
    return workspace;
  }

  private async buildAppHeaders(): Promise<HeadersInit> {
    if (this.config.botUsername && this.config.botAppPassword) {
      const credentials = `${this.config.botUsername}:${this.config.botAppPassword}`;
      return {
        Authorization: `Basic ${btoa(credentials)}`,
        Accept: "application/json",
      };
    }

    if (this.config.clientId && this.config.clientSecret) {
      const token = await getBitbucketClientCredentialsToken({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      });
      return {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
      };
    }

    throw new SourceControlProviderError(
      "Bitbucket app credentials not configured",
      "permanent"
    );
  }

  private async buildApiHeaders(auth?: SourceControlAuthContext): Promise<HeadersInit> {
    if (auth?.token) {
      return {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
      };
    }

    return this.buildAppHeaders();
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Bitbucket API error: ${response.status} ${text}`,
        new Error(text),
        response.status
      );
    }
    return response.json() as Promise<T>;
  }

  private ensureRepositoryInWorkspace(data: BitbucketRepositoryResponse): void {
    const workspace = this.requireWorkspace().toLowerCase();
    const repoWorkspace = data.workspace?.slug?.trim().toLowerCase();
    const repoOwner = data.full_name.split("/")[0]?.trim().toLowerCase();

    if (repoWorkspace === workspace || repoOwner === workspace) {
      return;
    }

    throw new SourceControlProviderError(
      `Repository '${data.full_name}' is outside the configured Bitbucket workspace`,
      "permanent",
      403
    );
  }

  private mapRepository(data: BitbucketRepositoryResponse): InstallationRepository {
    this.ensureRepositoryInWorkspace(data);
    const [owner = this.requireWorkspace(), name = data.name] = data.full_name.split("/");
    return {
      id: normalizeRepoId(data.uuid),
      owner,
      name,
      fullName: data.full_name,
      description: data.description ?? null,
      private: data.is_private,
      defaultBranch: data.mainbranch?.name ?? "main",
    };
  }

  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const data = await this.fetchJson<BitbucketRepositoryResponse>(
      `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
        },
      }
    );
    const repository = this.mapRepository(data);
    return {
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      isPrivate: repository.private,
      providerRepoId: repository.id,
    };
  }

  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const response = await fetch(
      `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.repository.owner)}/${encodeURIComponent(config.repository.name)}/pullrequests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: config.title,
          description: config.body,
          source: { branch: { name: config.sourceBranch } },
          destination: { branch: { name: config.targetBranch } },
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to create Bitbucket pull request: ${response.status} ${text}`,
        new Error(text),
        response.status
      );
    }

    const data = (await response.json()) as {
      id: number;
      links?: { html?: { href?: string }; self?: { href?: string } };
      state?: string;
      source?: { branch?: { name?: string } };
      destination?: { branch?: { name?: string } };
    };

    const stateValue = data.state?.toUpperCase();
    const state: CreatePullRequestResult["state"] =
      stateValue === "MERGED"
        ? "merged"
        : stateValue === "DECLINED" || stateValue === "SUPERSEDED"
          ? "closed"
          : "open";

    return {
      id: data.id,
      webUrl: data.links?.html?.href ?? "",
      apiUrl: data.links?.self?.href ?? "",
      state,
      sourceBranch: data.source?.branch?.name ?? config.sourceBranch,
      targetBranch: data.destination?.branch?.name ?? config.targetBranch,
    };
  }

  async checkRepositoryAccess(
    config: GetRepositoryConfig,
    auth?: SourceControlAuthContext
  ): Promise<RepositoryAccessResult | null> {
    try {
      const data = await this.fetchJson<BitbucketRepositoryResponse>(
        `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`,
        {
          headers: await this.buildApiHeaders(auth),
        }
      );
      const repository = this.mapRepository(data);
      return {
        repoId: repository.id,
        repoOwner: repository.owner.toLowerCase(),
        repoName: repository.name.toLowerCase(),
        defaultBranch: repository.defaultBranch,
      };
    } catch (error) {
      if (error instanceof SourceControlProviderError && error.httpStatus === 404) {
        return null;
      }
      throw toSourceControlProviderError("Failed to check repository access", error);
    }
  }

  async listRepositories(auth?: SourceControlAuthContext): Promise<InstallationRepository[]> {
    const workspace = this.requireWorkspace();
    const results: InstallationRepository[] = [];
    let nextUrl: string | null = `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(workspace)}?pagelen=100`;

    try {
      while (nextUrl) {
        const page: {
          values?: BitbucketRepositoryResponse[];
          next?: string;
        } = await this.fetchJson(nextUrl, { headers: await this.buildApiHeaders(auth) });
        results.push(
          ...(page.values ?? []).map((repo: BitbucketRepositoryResponse) => this.mapRepository(repo))
        );
        nextUrl = page.next ?? null;
      }
      return results;
    } catch (error) {
      throw toSourceControlProviderError("Failed to list Bitbucket repositories", error);
    }
  }

  async listBranches(
    config: GetRepositoryConfig,
    auth?: SourceControlAuthContext
  ): Promise<{ name: string }[]> {
    try {
      const access = await this.checkRepositoryAccess(config, auth);
      if (!access) {
        throw new SourceControlProviderError(
          `Repository '${config.owner}/${config.name}' is not accessible`,
          "permanent",
          404
        );
      }

      const branches: Array<{ name: string }> = [];
      let nextUrl: string | null = `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}/refs/branches?pagelen=100`;

      while (nextUrl) {
        const page = await this.fetchJson<{
          values?: Array<{ name: string }>;
          next?: string;
        }>(nextUrl, { headers: await this.buildApiHeaders(auth) });
        branches.push(...(page.values ?? []));
        nextUrl = page.next ?? null;
      }

      return branches;
    } catch (error) {
      throw toSourceControlProviderError("Failed to list Bitbucket branches", error);
    }
  }

  async getBranchHeadSha(config: GetBranchHeadShaConfig): Promise<string | null> {
    try {
      const data = await this.fetchJson<{
        target?: { hash?: string };
      }>(
        `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}/refs/branches/${encodeURIComponent(config.branch)}`,
        { headers: await this.buildAppHeaders() }
      );
      return data.target?.hash ?? null;
    } catch (error) {
      if (error instanceof SourceControlProviderError && error.httpStatus === 404) {
        return null;
      }
      throw toSourceControlProviderError("Failed to resolve Bitbucket branch head", error);
    }
  }

  async generatePushAuth(): Promise<GitPushAuthContext> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new SourceControlProviderError(
        "Bitbucket OAuth consumer credentials not configured for git push",
        "permanent"
      );
    }

    try {
      const token = await getBitbucketClientCredentialsToken({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      });
      return {
        authType: "token",
        token: token.access_token,
      };
    } catch (error) {
      throw toSourceControlProviderError("Failed to generate Bitbucket push auth", error);
    }
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const source = encodeURIComponent(`${config.owner}/${config.name}:${config.sourceBranch}`);
    const destination = encodeURIComponent(`${config.owner}/${config.name}:${config.targetBranch}`);
    return `https://bitbucket.org/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}/pull-requests/new?source=${source}&dest=${destination}`;
  }

  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec {
    return buildTokenGitPushSpec({
      host: "bitbucket.org",
      username: "x-token-auth",
      token: config.auth.token,
      owner: config.owner,
      name: config.name,
      sourceRef: config.sourceRef,
      targetBranch: config.targetBranch,
      force: config.force,
    });
  }
}

export function createBitbucketProvider(
  config: BitbucketProviderConfig = {}
): SourceControlProvider {
  return new BitbucketSourceControlProvider(config);
}
