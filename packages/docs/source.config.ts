import type { Root } from "mdast";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";

/**
 * Lift an image that is the only child of a paragraph out of that paragraph,
 * at any depth (list items and blockquotes included).
 * Markdown images are inline, so `![alt](src "caption")` on its own line
 * otherwise renders `<p><figure>…</figure></p>`, which is invalid HTML.
 * Runs after Fumadocs' image plugin, which has already turned the image
 * into an `<img>` JSX element with a static import but left it inside
 * the paragraph.
 */
type LooseNode = { type: string; name?: string; children?: LooseNode[] };

function liftSoleImage(node: LooseNode): LooseNode {
  if (node.type !== "paragraph" || node.children?.length !== 1) return node;
  const [child] = node.children;
  if (child.type === "image") return child;
  if (
    (child.type === "mdxJsxTextElement" || child.type === "mdxJsxFlowElement") &&
    child.name === "img"
  ) {
    return { ...child, type: "mdxJsxFlowElement" };
  }
  return node;
}

function unwrapImagesIn(parent: LooseNode): void {
  if (!parent.children || parent.type === "paragraph") return;
  parent.children = parent.children.map(liftSoleImage);
  parent.children.forEach(unwrapImagesIn);
}

function remarkUnwrapImages() {
  return (tree: Root) => {
    unwrapImagesIn(tree as unknown as LooseNode);
  };
}

export default defineConfig({
  mdxOptions: {
    // Turn ```mermaid code fences into the <Mermaid /> component registered in src/components/mdx.tsx.
    remarkPlugins: [remarkMdxMermaid, remarkUnwrapImages],
  },
});
