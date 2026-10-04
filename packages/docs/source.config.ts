import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";

import { remarkUnwrapImages } from "./src/lib/remark-unwrap-images";

export default defineConfig({
  mdxOptions: {
    // Ordering matters: remarkUnwrapImages has to see plain mdast `image` nodes,
    // so it runs before Fumadocs' own remarkImage, which is part of `builtIn`.
    remarkPlugins: (builtIn) => [
      remarkUnwrapImages,
      // Turn ```mermaid code fences into the <Mermaid /> component registered
      // in src/components/mdx.tsx.
      remarkMdxMermaid,
      ...builtIn,
    ],
  },
});
