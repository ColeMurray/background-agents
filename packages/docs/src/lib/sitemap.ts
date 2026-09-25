import type { MetadataRoute } from "next";

import { canonicalUrl } from "./site";

type PublicSitemapPage = {
  url: string;
  lastReviewed: string;
};

export function createSitemapEntries(pages: PublicSitemapPage[]): MetadataRoute.Sitemap {
  return pages.map((page) => ({
    url: canonicalUrl(page.url),
    lastModified: new Date(`${page.lastReviewed}T00:00:00.000Z`),
    changeFrequency: "monthly",
    priority: page.url === "/" ? 1 : 0.8,
  }));
}
