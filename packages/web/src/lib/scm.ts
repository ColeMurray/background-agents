/**
 * Source control manager URL utilities.
 *
 * Generates provider-appropriate URLs for repos and branches.
 * The active provider is read from NEXT_PUBLIC_SCM_PROVIDER (build-time env var),
 * defaulting to "github" for upstream compatibility.
 */

export type ScmProvider = "github" | "gitlab" | "bitbucket";

const BASE_URLS: Record<ScmProvider, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  bitbucket: "https://bitbucket.org",
};

function getProvider(): ScmProvider {
  const val = process.env.NEXT_PUBLIC_SCM_PROVIDER?.toLowerCase().trim();
  if (val === "github" || val === "gitlab" || val === "bitbucket") return val;
  return "github";
}

export function getScmRepoUrl(owner: string, name: string): string {
  const provider = getProvider();
  return `${BASE_URLS[provider]}/${owner}/${name}`;
}

export function getScmBranchUrl(owner: string, name: string, branch: string): string {
  const provider = getProvider();
  const encoded = encodeURIComponent(branch);
  if (provider === "gitlab") {
    return `${BASE_URLS[provider]}/${owner}/${name}/-/tree/${encoded}`;
  }
  if (provider === "bitbucket") {
    return `${BASE_URLS[provider]}/${owner}/${name}/src/${encoded}`;
  }
  // github (default)
  return `${BASE_URLS[provider]}/${owner}/${name}/tree/${encoded}`;
}
