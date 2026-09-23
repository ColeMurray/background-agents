import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

import { publicPageSchema } from "./content-policy";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: publicPageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
      extractLinkReferences: true,
    },
  },
});

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});

export type DocumentationPage = (typeof source)["$inferPage"];

export async function getLLMText(page: DocumentationPage) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})\n\n${processed}`;
}

export function getPageMarkdownUrl(page: DocumentationPage): string {
  return `/llms.mdx/${[...page.slugs, "content.md"].join("/")}`;
}
