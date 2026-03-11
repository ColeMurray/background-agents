import type { IntegrationId } from "@open-inspect/shared";

export type ScmProvider = "github" | "bitbucket";

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasBitbucketProviderSignal(env: {
  BITBUCKET_CLIENT_ID?: string;
  BITBUCKET_CLIENT_SECRET?: string;
  BITBUCKET_WORKSPACE?: string;
}): boolean {
  return (
    hasValue(env.BITBUCKET_CLIENT_ID) ||
    hasValue(env.BITBUCKET_CLIENT_SECRET) ||
    hasValue(env.BITBUCKET_WORKSPACE)
  );
}

function hasGitHubProviderSignal(env: {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}): boolean {
  return hasValue(env.GITHUB_CLIENT_ID) || hasValue(env.GITHUB_CLIENT_SECRET);
}

function resolveScmProvider(explicitProvider: string | undefined, env: {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BITBUCKET_CLIENT_ID?: string;
  BITBUCKET_CLIENT_SECRET?: string;
  BITBUCKET_WORKSPACE?: string;
}): ScmProvider {
  const normalizedProvider = explicitProvider?.trim().toLowerCase();
  if (normalizedProvider === "bitbucket") {
    return "bitbucket";
  }
  if (normalizedProvider === "github") {
    return "github";
  }

  const githubConfigured = hasGitHubProviderSignal(env);
  const bitbucketConfigured = hasBitbucketProviderSignal(env);
  if (bitbucketConfigured && !githubConfigured) {
    return "bitbucket";
  }

  return "github";
}

export function getServerScmProvider(): ScmProvider {
  return resolveScmProvider(process.env.SCM_PROVIDER, {
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    BITBUCKET_CLIENT_ID: process.env.BITBUCKET_CLIENT_ID,
    BITBUCKET_CLIENT_SECRET: process.env.BITBUCKET_CLIENT_SECRET,
    BITBUCKET_WORKSPACE: process.env.BITBUCKET_WORKSPACE,
  });
}

export function getScmProviderLabel(provider: ScmProvider): string {
  return provider === "bitbucket" ? "Bitbucket" : "GitHub";
}

export function buildRepoUrl(provider: ScmProvider, owner: string, name: string): string {
  if (provider === "bitbucket") {
    return `https://bitbucket.org/${owner}/${name}`;
  }
  return `https://github.com/${owner}/${name}`;
}

export function buildBranchUrl(
  provider: ScmProvider,
  owner: string,
  name: string,
  branch: string
): string {
  const encodedBranch = encodeURIComponent(branch);
  if (provider === "bitbucket") {
    return `https://bitbucket.org/${owner}/${name}/src/${encodedBranch}`;
  }
  return `https://github.com/${owner}/${name}/tree/${encodedBranch}`;
}

export function isIntegrationAvailable(id: IntegrationId, provider: ScmProvider): boolean {
  if (id === "github") {
    return provider === "github";
  }
  return true;
}
