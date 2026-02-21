/**
 * Bitbucket authentication utilities.
 */

import type { InstallationRepository } from "@open-inspect/shared";

export interface BitbucketOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface BitbucketTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scopes?: string;
}

interface BitbucketRepositoryResponse {
  uuid: string;
  name: string;
  full_name: string;
  description?: string | null;
  is_private: boolean;
  mainbranch?: { name?: string };
  workspace?: {
    slug?: string;
  };
}

interface BitbucketPaginatedRepositoriesResponse {
  values: BitbucketRepositoryResponse[];
  next?: string;
}

function mapBitbucketRepository(repo: BitbucketRepositoryResponse): InstallationRepository {
  const workspace = repo.workspace?.slug ?? repo.full_name.split("/")[0] ?? "";
  const fullName = repo.full_name || `${workspace}/${repo.name}`;
  return {
    id: repo.uuid,
    owner: workspace,
    name: repo.name,
    fullName,
    description: repo.description ?? null,
    private: repo.is_private,
    defaultBranch: repo.mainbranch?.name ?? "main",
  };
}

/**
 * Refresh a Bitbucket OAuth access token.
 */
export async function refreshBitbucketAccessToken(
  refreshToken: string,
  config: BitbucketOAuthConfig
): Promise<BitbucketTokenResponse> {
  const basicAuth = btoa(`${config.clientId}:${config.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const payload = (await response.json()) as BitbucketTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok || payload.error || !payload.access_token) {
    const message = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Bitbucket token refresh failed: ${message}`);
  }

  return payload;
}

/**
 * List repositories accessible to a Bitbucket bot account.
 */
export async function listBitbucketRepositories(
  username: string,
  appPassword: string
): Promise<InstallationRepository[]> {
  const auth = `Basic ${btoa(`${username}:${appPassword}`)}`;
  const repositories: InstallationRepository[] = [];
  let nextUrl = "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100";

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: auth,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list Bitbucket repositories: ${response.status} ${error}`);
    }

    const payload = (await response.json()) as BitbucketPaginatedRepositoriesResponse;
    repositories.push(...payload.values.map(mapBitbucketRepository));
    nextUrl = payload.next ?? "";
  }

  return repositories;
}

/**
 * List repositories accessible to a Bitbucket OAuth user token.
 */
export async function listBitbucketRepositoriesWithOAuth(
  accessToken: string
): Promise<InstallationRepository[]> {
  const repositories: InstallationRepository[] = [];
  let nextUrl = "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100";

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list Bitbucket repositories: ${response.status} ${error}`);
    }

    const payload = (await response.json()) as BitbucketPaginatedRepositoriesResponse;
    repositories.push(...payload.values.map(mapBitbucketRepository));
    nextUrl = payload.next ?? "";
  }

  return repositories;
}

/**
 * Resolve a specific Bitbucket repository accessible to a bot account.
 */
export async function getBitbucketRepository(
  username: string,
  appPassword: string,
  owner: string,
  repoName: string
): Promise<InstallationRepository | null> {
  const auth = `Basic ${btoa(`${username}:${appPassword}`)}`;
  const response = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
    {
      headers: {
        Authorization: auth,
        Accept: "application/json",
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch Bitbucket repository: ${response.status} ${error}`);
  }

  const payload = (await response.json()) as BitbucketRepositoryResponse;
  return mapBitbucketRepository(payload);
}

/**
 * Resolve a specific Bitbucket repository accessible to an OAuth user token.
 */
export async function getBitbucketRepositoryWithOAuth(
  accessToken: string,
  owner: string,
  repoName: string
): Promise<InstallationRepository | null> {
  const response = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch Bitbucket repository: ${response.status} ${error}`);
  }

  const payload = (await response.json()) as BitbucketRepositoryResponse;
  return mapBitbucketRepository(payload);
}
