import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

import { publicPageSchema } from "@/lib/content-policy";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: publicPageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})\n\n${processed}`;
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]): string {
  return `/llms.mdx/${[...page.slugs, "content.md"].join("/")}`;
}
