export const site = {
  name: "OpenInspect Docs",
  titleTemplate: "%s | OpenInspect Docs",
  description: "Learn how to delegate, monitor, review, and operate background coding agents.",
  url: "https://docs.backgroundagents.dev",
  productUrl: "https://backgroundagents.dev",
  repositoryUrl: "https://github.com/ColeMurray/background-agents",
} as const;

export function canonicalUrl(pathname: string): string {
  return new URL(pathname, site.url).toString();
}
