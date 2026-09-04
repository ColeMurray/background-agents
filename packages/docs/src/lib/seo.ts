import { canonicalUrl } from "./site";

type TechArticleInput = {
  title: string;
  description: string;
  path: string;
  lastReviewed: string;
};

export function createTechArticleJsonLd(input: TechArticleInput) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: input.title,
    description: input.description,
    dateModified: input.lastReviewed,
    mainEntityOfPage: canonicalUrl(input.path),
    publisher: {
      "@type": "Organization",
      name: "Background Agents",
      url: "https://backgroundagents.dev",
    },
  } as const;
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
