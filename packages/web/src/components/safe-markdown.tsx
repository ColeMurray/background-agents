"use client";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ComponentPropsWithoutRef } from "react";
import { isRepositoryFileHref } from "@/lib/diff-file-links";
import { useSessionFileLinks } from "@/lib/session-file-links";

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
    "span",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Only allow href on links, and only http/https protocols
    a: ["href"],
    // Allow className for syntax highlighting
    code: ["className"],
    span: ["className"],
    pre: ["className"],
  },
  protocols: {
    href: ["http", "https"],
  },
  // Strip all other attributes
  strip: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
};

interface SafeMarkdownProps {
  content: string;
  className?: string;
  /**
   * Inside a session, open links to changed repository files in the changes panel. Only
   * agent-authored text opts in; other markdown (e.g. pull request bodies) keeps plain links.
   */
  linkRepositoryFiles?: boolean;
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

  if (!fileLinks || !isRepositoryFileHref(href)) {
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
      onClick={() => fileLinks.open(selection)}
    >
      {children}
    </button>
  );
}

export function SafeMarkdown({
  content,
  className = "",
  linkRepositoryFiles = false,
}: SafeMarkdownProps) {
  return (
    <div
      className={`prose prose-sm dark:prose-invert min-w-0 max-w-none break-words [overflow-wrap:anywhere] ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
        components={{
          // Links open in a new tab with security attributes; with linkRepositoryFiles, links
          // to changed repository files open them in the changes panel instead
          a: linkRepositoryFiles ? RepositoryFileMarkdownLink : MarkdownLink,
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
