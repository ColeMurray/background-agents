/**
 * Pull Request creation and management.
 */

import { decryptToken } from "./crypto";
import type { CreatePRRequest, CreatePRResponse, RepositoryInfo } from "../ports/types";

/**
 * Create a pull request on GitHub.
 */
export async function createPullRequest(
  request: CreatePRRequest,
  encryptionKey: string
): Promise<CreatePRResponse> {
  // Decrypt the user's token
  const accessToken = await decryptToken(request.accessTokenEncrypted, encryptionKey);

  const response = await fetch(
    `https://api.github.com/repos/${request.owner}/${request.repo}/pulls`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Open-Inspect",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: request.title,
        body: request.body,
        head: request.head,
        base: request.base,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create PR: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    number: number;
    html_url: string;
    url: string;
    state: string;
  };

  return {
    number: data.number,
    url: data.url,
    htmlUrl: data.html_url,
    state: data.state,
  };
}

/**
 * Get an existing pull request by head branch.
 */
export async function getPullRequestByHead(
  accessToken: string,
  owner: string,
  repo: string,
  head: string
): Promise<CreatePRResponse | null> {
  // Head format should be "owner:branch" for forks, or just "branch" for same repo
  const headParam = head.includes(":") ? head : `${owner}:${head}`;

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(headParam)}&state=open`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Open-Inspect",
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  const pulls = (await response.json()) as Array<{
    number: number;
    html_url: string;
    url: string;
    state: string;
  }>;

  if (pulls.length === 0) {
    return null;
  }

  const pr = pulls[0];
  return {
    number: pr.number,
    url: pr.url,
    htmlUrl: pr.html_url,
    state: pr.state,
  };
}

/**
 * Update an existing pull request.
 */
export async function updatePullRequest(
  accessToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  updates: { title?: string; body?: string; state?: "open" | "closed" }
): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Open-Inspect",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update PR: ${response.status} ${error}`);
  }
}

/**
 * Add a comment to a pull request.
 */
export async function addPRComment(
  accessToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Open-Inspect",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to add comment: ${response.status} ${error}`);
  }
}

/**
 * Get repository information.
 */
export async function getRepository(
  accessToken: string,
  owner: string,
  repo: string
): Promise<RepositoryInfo> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Open-Inspect",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get repository: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    default_branch: string;
    private: boolean;
    full_name: string;
  };

  return {
    defaultBranch: data.default_branch,
    private: data.private,
    fullName: data.full_name,
  };
}

/**
 * List user's repositories.
 */
export async function listUserRepositories(
  accessToken: string,
  perPage: number = 100
): Promise<
  Array<{
    id: number;
    fullName: string;
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string;
  }>
> {
  const response = await fetch(
    `https://api.github.com/user/repos?per_page=${perPage}&sort=updated`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Open-Inspect",
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list repositories: ${response.status} ${error}`);
  }

  const repos = (await response.json()) as Array<{
    id: number;
    full_name: string;
    owner: { login: string };
    name: string;
    private: boolean;
    default_branch: string;
  }>;

  return repos.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
  }));
}
