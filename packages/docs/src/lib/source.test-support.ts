import { fileURLToPath } from "node:url";
import mdx from "fumadocs-mdx/vite";
import { createServer, createServerModuleRunner } from "vite";

import type { renderLlmsIndex } from "./llms";
import type { getPageMarkdownUrl, source } from "./source";

type SourceModule = { source: typeof source; getPageMarkdownUrl: typeof getPageMarkdownUrl };
type LlmsModule = { renderLlmsIndex: typeof renderLlmsIndex };

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Loads the site's content source the same way the app does: through the
 * Fumadocs MDX compiler. Tests consume parsed page data and routes from this
 * one source instead of re-parsing frontmatter or duplicating the route table.
 */
export async function loadDocumentationSource() {
  const server = await createServer({
    root: packageRoot,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    plugins: mdx(),
    resolve: { alias: { "@": `${packageRoot}src` } },
    server: { middlewareMode: true, watch: null },
  });
  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const [sourceModule, llmsModule] = await Promise.all([
      runner.import("/src/lib/source.ts") as Promise<SourceModule>,
      runner.import("/src/lib/llms.ts") as Promise<LlmsModule>,
    ]);
    return {
      source: sourceModule.source,
      getPageMarkdownUrl: sourceModule.getPageMarkdownUrl,
      renderLlmsIndex: llmsModule.renderLlmsIndex,
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
