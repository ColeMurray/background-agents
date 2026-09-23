import type { Root, RootContent } from "mdast";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";

/**
 * Lift an image that is the only child of a paragraph out of that paragraph.
 * Markdown images are inline, so `![alt](src "caption")` on its own line
 * otherwise renders `<p><figure>…</figure></p>`, which is invalid HTML.
 * Runs after Fumadocs' image plugin, which has already turned the image
 * into an `<img>` JSX element with a static import but left it inside
 * the paragraph.
 */
type LooseNode = { type: string; name?: string };

function remarkUnwrapImages() {
  return (tree: Root) => {
    tree.children = tree.children.map((node): RootContent => {
      if (node.type !== "paragraph" || node.children.length !== 1) return node;
      const [child] = node.children;
      const loose = child as unknown as LooseNode;
      if (loose.type === "image") return child;
      if (
        (loose.type === "mdxJsxTextElement" || loose.type === "mdxJsxFlowElement") &&
        loose.name === "img"
      ) {
        return { ...(child as object), type: "mdxJsxFlowElement" } as unknown as RootContent;
      }
      return node;
    });
  };
}

export default defineConfig({
  mdxOptions: {
    // Turn ```mermaid code fences into the <Mermaid /> component registered in src/components/mdx.tsx.
    remarkPlugins: [remarkMdxMermaid, remarkUnwrapImages],
  },
});
