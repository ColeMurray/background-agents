export const site = {
  name: "Background Agents Docs",
  titleTemplate: "%s | Background Agents Docs",
  description: "Learn how to delegate, monitor, review, and operate background coding agents.",
  url: "https://docs.backgroundagents.dev",
  productUrl: "https://backgroundagents.dev",
  repositoryUrl: "https://github.com/ColeMurray/background-agents",
} as const;

export function canonicalUrl(pathname: string): string {
  return new URL(pathname, site.url).toString();
}
