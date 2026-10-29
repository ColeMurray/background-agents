"use client";

import ReactMarkdown from "react-markdown";
import { MarkdownPre, MermaidMarkdownContext } from "./mermaid-code-block";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ComponentPropsWithoutRef } from "react";
import type { Root, RootContent } from "mdast";
import { isPathWithLineReference, isRepositoryFileHref } from "@/lib/diff-file-links";
import { useSessionFileLinks } from "@/lib/session-file-links";
import { getSafeExternalUrl } from "@/lib/urls";
import { remarkClosedFences } from "@/lib/remark-closed-fences";

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
    code: ["className", ["dataFenceClosed", "true"]],
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
  /** Enable diagrams only for assistant timeline messages. */
  renderMermaid?: boolean;
  className?: string;
  baseUrl?: string;
  imageMode?: "omit" | "placeholder";
  /**
   * - `plain`: every sanitized link opens in a new tab.
   * - `repositoryFiles`: inside a session, links to changed repository files open in the
   *   changes panel. Only agent-authored text opts in; other markdown (e.g. pull request
   *   bodies) keeps plain links.
   * - `externalOnly`: untrusted repository documents. Only safe external URLs open; relative
   *   and in-page links are inert so the document cannot navigate the session.
   */
  linkMode?: "plain" | "repositoryFiles" | "externalOnly";
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

function ExternalOnlyMarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  const externalHref = getSafeExternalUrl(href);
  if (!externalHref) {
    return (
      <span className="text-muted-foreground" title={href}>
        {children}
      </span>
    );
  }
  return (
    <MarkdownLink href={externalHref} {...props}>
      {children}
    </MarkdownLink>
  );
}

function MarkdownUnorderedList({ children, ...props }: ComponentPropsWithoutRef<"ul">) {
  return (
    <ul className="list-disc pl-4 mb-2" {...props}>
      {children}
    </ul>
  );
}

function MarkdownOrderedList({ children, ...props }: ComponentPropsWithoutRef<"ol">) {
  return (
    <ol className="list-decimal pl-4 mb-2" {...props}>
      {children}
    </ol>
  );
}

function MarkdownBlockquote({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) {
  return (
    <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground" {...props}>
      {children}
    </blockquote>
  );
}

export function SafeMarkdown({
  content,
  renderMermaid = false,
  className = "",
  baseUrl,
  imageMode = DEFAULT_IMAGE_MODE,
  linkMode = "plain",
}: SafeMarkdownProps) {
  return (
    <div
      className={`prose prose-sm dark:prose-invert min-w-0 max-w-none break-words [overflow-wrap:anywhere] ${className}`}
    >
      <MermaidMarkdownContext.Provider value={renderMermaid}>
        <ReactMarkdown
          remarkPlugins={
            linkMode === "repositoryFiles"
              ? [remarkGfm, remarkClosedFences, preserveFileLineReferences]
              : [remarkGfm, remarkClosedFences]
          }
          rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
          components={{
            a: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => {
              if (linkMode === "externalOnly") {
                return (
                  <ExternalOnlyMarkdownLink href={href} {...props}>
                    {children}
                  </ExternalOnlyMarkdownLink>
                );
              }
              const resolvedHref = resolveMarkdownUrl(href, baseUrl);
              if (!resolvedHref) return <span>{children}</span>;
              if (linkMode === "repositoryFiles" && isRepositoryFileHref(href)) {
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
              if (imageMode !== "placeholder") return null;
              return <span>{resolvedSrc ? `${alt?.trim() || "Image"}: ${resolvedSrc}` : alt}</span>;
            },
            // Code blocks with styling
            pre: MarkdownPre,
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
            ul: MarkdownUnorderedList,
            ol: MarkdownOrderedList,
            // Blockquotes
            blockquote: MarkdownBlockquote,
            // Tables: break-words resets the inherited overflow-wrap:anywhere, which would
            // let auto layout shrink columns to one character; wide tables scroll instead.
            table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
              <div className="max-w-full overflow-x-auto">
                <table className="min-w-full border-collapse text-sm break-words" {...props}>
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
      </MermaidMarkdownContext.Provider>
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
