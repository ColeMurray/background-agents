import { notFound } from "next/navigation";

import { getLLMText, source } from "@/lib/source";

type MarkdownRouteContext = {
  params: Promise<{ slug?: string[] }>;
};

export const revalidate = false;

export async function GET(_request: Request, { params }: MarkdownRouteContext) {
  const { slug = [] } = await params;
  if (slug.at(-1) !== "content.md") notFound();

  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: [...page.slugs, "content.md"],
  }));
}
