import { getBreadcrumbItems } from "fumadocs-core/breadcrumb";
import type * as PageTree from "fumadocs-core/page-tree";

import { site } from "./site";

export const socialCardSize = { width: 1200, height: 630 };

export type SocialCard = {
  /** Section the page sits in, shown small above the title. */
  section?: string;
  title: string;
  description: string;
};

type CardPage = {
  url: string;
  data: { title: string; description?: string };
};

/** Text of a page's Open Graph card. The home page is the "Documentation" card. */
export function socialCard(page: CardPage, tree: PageTree.Root): SocialCard {
  if (page.url === "/") return { title: "Documentation", description: site.description };

  const parent = getBreadcrumbItems(page.url, tree).at(-1)?.name;
  return {
    section: typeof parent === "string" ? parent : undefined,
    title: page.data.title,
    description: page.data.description ?? site.description,
  };
}
