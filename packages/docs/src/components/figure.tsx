import { ImageZoom, type ImageZoomProps } from "fumadocs-ui/components/image-zoom";
import type { ComponentProps } from "react";

/**
 * Renders Markdown images as zoomable figures. A Markdown image title
 * (`![alt](/images/x.png "Caption")`) becomes the visible caption.
 *
 * Takes the plain `img` props, which is what MDX requires of an `img`
 * replacement. React types `src` more widely than `next/image` accepts (it
 * admits a `Blob`), while Fumadocs' `remarkImage` only ever passes the static
 * import or URL string that `ImageZoom` wants.
 */
export function Figure({ title, ...props }: ComponentProps<"img">) {
  return (
    <figure className="not-prose my-6 overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <ImageZoom {...(props as ImageZoomProps)} className="w-full" />
      {title ? (
        <figcaption className="border-t border-fd-border px-4 py-2 text-sm text-fd-muted-foreground">
          {title}
        </figcaption>
      ) : null}
    </figure>
  );
}
