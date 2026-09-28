import type { Root } from "mdast";
import { describe, expect, it } from "vitest";

import { remarkUnwrapImages } from "./remark-unwrap-images";

const image = (url: string) => ({ type: "image" as const, url, alt: "" });
const text = (value: string) => ({ type: "text" as const, value });

function unwrap(tree: Root): Root {
  remarkUnwrapImages()(tree);
  return tree;
}

describe("remarkUnwrapImages", () => {
  // src/components/figure.tsx renders images as a <figure>, which is invalid
  // inside the <p> that a sole-image paragraph would otherwise produce.
  it("replaces a paragraph that holds only an image with the image", () => {
    const tree = unwrap({
      type: "root",
      children: [{ type: "paragraph", children: [image("/images/one.webp")] }],
    });

    expect(tree.children).toEqual([image("/images/one.webp")]);
  });

  it("leaves an image that shares its paragraph with text inline", () => {
    const paragraph = {
      type: "paragraph" as const,
      children: [text("see "), image("/images/two.webp")],
    };

    expect(unwrap({ type: "root", children: [paragraph] }).children).toEqual([paragraph]);
  });

  it("unwraps inside a list item, where images also render as figures", () => {
    const tree = unwrap({
      type: "root",
      children: [
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [{ type: "paragraph", children: [image("/images/three.webp")] }],
            },
          ],
        },
      ],
    });

    expect(tree.children[0]).toMatchObject({
      type: "list",
      children: [{ type: "listItem", children: [image("/images/three.webp")] }],
    });
  });

  it("leaves a paragraph of prose untouched", () => {
    const paragraph = { type: "paragraph" as const, children: [text("just words")] };

    expect(unwrap({ type: "root", children: [paragraph] }).children).toEqual([paragraph]);
  });
});
