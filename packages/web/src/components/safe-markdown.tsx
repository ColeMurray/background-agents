"use client";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useId, type ComponentPropsWithoutRef } from "react";
import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import type { Root, RootContent } from "mdast";
import { isPathWithLineReference, isRepositoryFileHref } from "@/lib/diff-file-links";
import { useSessionFileLinks } from "@/lib/session-file-links";
import { getSafeExternalUrl } from "@/lib/urls";

// Strict sanitization schema to prevent XSS
// Based on GitHub's sanitization but even more restrictive
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    // Block elements
    "p",
    "blockquote",
    "pre",
    "code",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
    "br",
    // Inline elements
    "strong",
    "em",
    "del",
    "a",
    "img",
    "span",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Only allow href on links, and only http/https protocols
    a: ["href"],
    img: ["src", "alt", "title"],
    // Allow className for syntax highlighting
    code: ["className"],
    span: ["className"],
    pre: ["className"],
  },
  protocols: {
    href: ["http", "https"],
    src: ["http", "https"],
  },
  // Strip all other attributes
  strip: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
};
const DEFAULT_IMAGE_MODE = "omit";

function preserveFileLineReferences() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        isPathWithLineReference(node.url)
      ) {
        // A root-level path with :line looks like a URL scheme to rehype-sanitize.
        node.url = `./${node.url}`;
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

interface SafeMarkdownProps {
  content: string;
  className?: string;
  baseUrl?: string;
  imageMode?: "omit" | "placeholder";
  /**
   * Inside a session, open links to changed repository files in the changes panel. Only
   * agent-authored text opts in; other markdown (e.g. pull request bodies) keeps plain links.
   */
  linkRepositoryFiles?: boolean;
  /**
   * Untrusted repository markdown, such as a changes preview. Https links open in a new
   * tab, in-document anchors stay inside this document, and every other URL is inert so
   * it cannot navigate the session or load a repository asset. Images are placeholders.
   */
  untrustedDocument?: boolean;
}

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-accent hover:underline"
      {...props}
    >
      {children}
    </a>
  );
}

function RepositoryFileMarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  const fileLinks = useSessionFileLinks();

  if (!fileLinks) {
    return (
      <MarkdownLink href={href} {...props}>
        {children}
      </MarkdownLink>
    );
  }

  const selection = fileLinks.resolve(href);
  if (!selection) {
    // The control plane can only show files in the session's diff, so a link to any
    // other repository file has nowhere to go; plain text beats a link that 404s.
    return (
      <span className="text-muted-foreground" title="Not in this session's changes">
        {children}
      </span>
    );
  }
  // An in-page action, not a destination: a button, so middle-click and "Open link" can't
  // navigate to the session-relative href.
  return (
    <button
      type="button"
      className="text-accent hover:underline cursor-pointer bg-transparent p-0 border-0 text-left font-[inherit]"
      title={selection.path}
      onClick={(event) => fileLinks.open(selection, event.currentTarget)}
    >
      {children}
    </button>
  );
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function hastText(node: HastRoot | HastContent): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(hastText).join("");
  return "";
}

function rehypeScopedHeadingIds(scope: string) {
  return () => (tree: HastRoot) => {
    const counts = new Map<string, number>();
    const visit = (node: HastRoot | HastElement) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (HEADING_TAGS.has(child.tagName)) {
          const base = slugifyHeading(hastText(child));
          const seen = counts.get(base) ?? 0;
          counts.set(base, seen + 1);
          child.properties.id = `${scope}-${seen === 0 ? base : `${base}-${seen}`}`;
        } else {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return slug || "section";
}

function scopedFragment(href: string, scope: string): string | null {
  if (!href.startsWith("#") || href.length < 2) return null;
  let fragment = href.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  fragment = fragment.toLowerCase();
  if (!/^[\p{L}\p{N}_-]+$/u.test(fragment)) return null;
  return `${scope}-${fragment}`;
}

function httpsDocumentHref(href: string | undefined): string | null {
  const safe = getSafeExternalUrl(href);
  if (!safe) return null;
  return new URL(safe).protocol === "https:" ? safe : null;
}

export function SafeMarkdown({
  content,
  className = "",
  baseUrl,
  imageMode = DEFAULT_IMAGE_MODE,
  linkRepositoryFiles = false,
  untrustedDocument = false,
}: SafeMarkdownProps) {
  const anchorScope = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const resolvedImageMode = untrustedDocument ? "placeholder" : imageMode;

  return (
    <div
      className={`prose prose-sm dark:prose-invert min-w-0 max-w-none break-words [overflow-wrap:anywhere] ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={linkRepositoryFiles ? [remarkGfm, preserveFileLineReferences] : [remarkGfm]}
        rehypePlugins={
          untrustedDocument
            ? [
                rehypeHighlight,
                [rehypeSanitize, sanitizeSchema],
                rehypeScopedHeadingIds(anchorScope),
              ]
            : [rehypeHighlight, [rehypeSanitize, sanitizeSchema]]
        }
        components={{
          a: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => {
            if (untrustedDocument) {
              const external = httpsDocumentHref(href);
              if (external) {
                return (
                  <MarkdownLink href={external} {...props}>
                    {children}
                  </MarkdownLink>
                );
              }
              const fragment = href ? scopedFragment(href, anchorScope) : null;
              if (fragment) {
                return (
                  <a href={`#${fragment}`} className="text-accent hover:underline">
                    {children}
                  </a>
                );
              }
              return (
                <span
                  className="text-muted-foreground"
                  title={href ? `Not opened from preview: ${href}` : undefined}
                >
                  {children}
                </span>
              );
            }
            const resolvedHref = resolveMarkdownUrl(href, baseUrl);
            if (!resolvedHref) return <span>{children}</span>;
            if (linkRepositoryFiles && isRepositoryFileHref(href)) {
              return (
                <RepositoryFileMarkdownLink href={href} {...props}>
                  {children}
                </RepositoryFileMarkdownLink>
              );
            }
            return (
              <MarkdownLink href={resolvedHref} {...props}>
                {children}
              </MarkdownLink>
            );
          },
          img: ({ src, alt }: ComponentPropsWithoutRef<"img">) => {
            const resolvedSrc = resolveMarkdownUrl(
              typeof src === "string" ? src : undefined,
              baseUrl
            );
            if (resolvedImageMode !== "placeholder") return null;
            return <span>{resolvedSrc ? `${alt?.trim() || "Image"}: ${resolvedSrc}` : alt}</span>;
          },
          // Code blocks with styling
          pre: ({ children, ...props }: ComponentPropsWithoutRef<"pre">) => (
            <pre
              className="not-prose max-w-full overflow-x-auto text-sm leading-relaxed rounded"
              {...props}
            >
              {children}
            </pre>
          ),
          code: ({ className, children, ...props }: ComponentPropsWithoutRef<"code">) => {
            // Code blocks: pass through hljs/language classes for syntax highlighting
            if (className) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            // Inline code: explicit styling with background, border, and monospace
            return (
              <code
                className="font-mono bg-muted border border-border rounded px-1.5 py-0.5 text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            );
          },
          // Paragraphs
          p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => (
            <p className="mb-2 last:mb-0" {...props}>
              {children}
            </p>
          ),
          // Lists
          ul: ({ children, ...props }: ComponentPropsWithoutRef<"ul">) => (
            <ul className="list-disc pl-4 mb-2" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }: ComponentPropsWithoutRef<"ol">) => (
            <ol className="list-decimal pl-4 mb-2" {...props}>
              {children}
            </ol>
          ),
          // Blockquotes
          blockquote: ({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) => (
            <blockquote
              className="border-l-4 border-border pl-4 italic text-muted-foreground"
              {...props}
            >
              {children}
            </blockquote>
          ),
          // Tables
          table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
            <div className="max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse text-sm" {...props}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }: ComponentPropsWithoutRef<"th">) => (
            <th className="border border-border px-3 py-1 bg-card font-medium" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }: ComponentPropsWithoutRef<"td">) => (
            <td className="border border-border px-3 py-1" {...props}>
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function resolveMarkdownUrl(value: string | undefined, baseUrl: string | undefined): string | null {
  if (!value) return null;
  if (!baseUrl) return value;
  try {
    const resolved = new URL(value, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
}
