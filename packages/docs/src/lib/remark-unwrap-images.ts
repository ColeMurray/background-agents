import type { Root } from "mdast";
import type { Node } from "unist";
import { visit } from "unist-util-visit";

/**
 * Replace a paragraph that holds nothing but an image with the image itself.
 * Markdown images are inline, so `![alt](src "caption")` on its own line would
 * otherwise render the `<figure>` from `src/components/figure.tsx` inside a
 * `<p>` — invalid HTML that React fails to hydrate.
 *
 * Ordered ahead of Fumadocs' own `remarkImage` in `source.config.ts`, so this
 * only ever sees plain mdast `image` nodes. `remarkImage` then rewrites the
 * image wherever it now sits, which keeps this plugin independent of the JSX
 * that Fumadocs generates.
 */
export function remarkUnwrapImages() {
  return (tree: Root) => {
    visit(tree, "paragraph", (paragraph, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const [image] = paragraph.children;
      if (paragraph.children.length !== 1 || image.type !== "image") return;
      // An image is phrasing content, so mdast does not type it as a child of
      // every block parent; at a block position it compiles the same way.
      (parent.children as Node[])[index] = image;
    });
  };
}
