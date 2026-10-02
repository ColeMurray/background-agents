import type { ProjectSourceInput } from "@open-inspect/shared/types/projects";

/** Repository documents refer to the current checkout, not remotely fetched file contents. */
export function inferProjectSourceReference(
  ref: string
): Pick<ProjectSourceInput, "sourceType" | "externalIdOrUrl"> {
  const unchanged = { sourceType: "url" as const, externalIdOrUrl: ref };
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return unchanged;
  }
  if (url.protocol !== "https:") return unchanged;
  if (url.hostname === "linear.app") return { ...unchanged, sourceType: "linear_project" };
  if (/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname))
    return { ...unchanged, sourceType: "slack_channel" };
  // Named refs may contain slashes; only a full commit SHA gives an unambiguous boundary.
  const match =
    url.hostname === "github.com"
      ? /^\/([^/]+\/[^/]+)\/blob\/[a-fA-F0-9]{40}\/(.+)$/.exec(url.pathname)
      : url.hostname === "gitlab.com"
        ? /^\/(.+\/[^/]+)\/-\/blob\/[a-fA-F0-9]{40}\/(.+)$/.exec(url.pathname)
        : null;
  if (!match) return unchanged;
  try {
    return {
      sourceType: "repo_doc",
      externalIdOrUrl: `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`,
    };
  } catch {
    return unchanged;
  }
}
