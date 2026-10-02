import type * as PageTree from "fumadocs-core/page-tree";
import type { ReactNode } from "react";

/** Content directories of the sections a lost reader is most likely looking for. */
export const primarySectionDirectories = [
  "getting-started",
  "prompting",
  "sessions",
  "configure",
  "automations",
  "reference",
] as const;

export type SectionLink = {
  name: ReactNode;
  url: string;
};

/** URL of a folder's index page, or else of the first page in sidebar order. */
function entryUrl(folder: PageTree.Folder): string | undefined {
  if (folder.index) return folder.index.url;
  for (const child of folder.children) {
    if (child.type === "page") return child.url;
    if (child.type === "folder") {
      const url = entryUrl(child);
      if (url) return url;
    }
  }
  return undefined;
}

/** Sidebar name and entry URL of each top-level section, in the order given. */
export function sectionLinks(
  tree: PageTree.Root,
  directories: readonly string[] = primarySectionDirectories
): SectionLink[] {
  const sections = tree.children.flatMap((node) => {
    if (node.type !== "folder") return [];
    const url = entryUrl(node);
    return url ? [{ directory: url.split("/")[1], name: node.name, url }] : [];
  });

  return directories.flatMap((directory) => {
    const section = sections.find((candidate) => candidate.directory === directory);
    return section ? [{ name: section.name, url: section.url }] : [];
  });
}
