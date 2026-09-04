import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";

import { getMDXComponents } from "@/components/mdx";
import { PageActions } from "@/components/page-actions";
import { createTechArticleJsonLd, serializeJsonLd } from "@/lib/seo";
import { canonicalUrl } from "@/lib/site";
import { getPageMarkdownUrl, source } from "@/lib/source";

type DocumentationPageProps = {
  params: Promise<{ slug?: string[] }>;
};

export default async function DocumentationPage({ params }: DocumentationPageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const jsonLd = createTechArticleJsonLd({
    title: page.data.title,
    description: page.data.description,
    path: page.url,
    lastReviewed: page.data.lastReviewed,
  });

  return (
    <>
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
        type="application/ld+json"
      />
      <DocsPage
        toc={page.data.toc}
        full={page.data.full}
        lastUpdate={page.data.lastReviewed}
        editOnGithub={{
          owner: "ColeMurray",
          repo: "background-agents",
          path: `packages/docs/${page.path}`,
        }}
      >
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <PageActions markdownUrl={getPageMarkdownUrl(page)} title={page.data.title} />
        <DocsBody>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(source, page),
            })}
          />
        </DocsBody>
      </DocsPage>
    </>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocumentationPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const url = canonicalUrl(page.url);

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      type: "article",
      siteName: "Background Agents",
      title: page.data.title,
      description: page.data.description,
      url,
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
    },
  };
}
