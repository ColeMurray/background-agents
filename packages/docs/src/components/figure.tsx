import { ImageZoom, type ImageZoomProps } from "fumadocs-ui/components/image-zoom";

/**
 * Renders Markdown images as zoomable figures. A Markdown image title
 * (`![alt](/images/x.png "Caption")`) becomes the visible caption.
 */
export function Figure({ title, ...props }: ImageZoomProps) {
  return (
    <figure className="not-prose my-6 overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <ImageZoom {...props} className="w-full" />
      {title ? (
        <figcaption className="border-t border-fd-border px-4 py-2 text-sm text-fd-muted-foreground">
          {title}
        </figcaption>
      ) : null}
    </figure>
  );
}
