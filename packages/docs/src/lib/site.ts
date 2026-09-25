export const site = {
  name: "OpenInspect Docs",
  titleTemplate: "%s | OpenInspect Docs",
  description: "Learn how to delegate, monitor, review, and operate background coding agents.",
  url: "https://docs.backgroundagents.dev",
  productUrl: "https://backgroundagents.dev",
  repositoryUrl: "https://github.com/ColeMurray/background-agents",
  /** The one place that knows where public content lives in the repository. */
  repository: {
    owner: "ColeMurray",
    name: "background-agents",
    branch: "main",
    contentDirectory: "packages/docs/content/docs",
  },
} as const;

export function canonicalUrl(pathname: string): string {
  return new URL(pathname, site.url).toString();
}

/** Repository path of a content file, from its path relative to the content directory. */
export function contentFilePath(pagePath: string): string {
  return `${site.repository.contentDirectory}/${pagePath.replace(/^\/+/, "")}`;
}

/** GitHub URL that opens the content file for editing on the published branch. */
export function editOnGitHubUrl(pagePath: string): string {
  const { owner, name, branch } = site.repository;
  return `https://github.com/${owner}/${name}/blob/${branch}/${contentFilePath(pagePath)}`;
}

/** Pre-filled issue link for feedback about one page. */
export function feedbackIssueUrl(title: string): string {
  const url = new URL(`${site.repositoryUrl}/issues/new`);
  url.searchParams.set("title", `Docs feedback: ${title}`);
  url.searchParams.set("labels", "documentation");
  return url.toString();
}
