import type { MetadataRoute } from "next";

import { createSitemapEntries } from "@/lib/sitemap";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return createSitemapEntries(
    source.getPages().map((page) => ({
      url: page.url,
      lastReviewed: page.data.lastReviewed,
    }))
  );
}
