"use client";

import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ComponentPropsWithoutRef } from "react";

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
}

export function SafeMarkdown({ content, className = "" }: SafeMarkdownProps) {
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={{
          // Custom link renderer - opens in new tab with security attributes
          a: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-accent hover:underline"
              {...props}
            >
              {children}
            </a>
          ),
          // Code blocks with styling
          pre: ({ children, ...props }: ComponentPropsWithoutRef<"pre">) => (
            <pre className="bg-card text-foreground p-3 overflow-x-auto text-sm" {...props}>
              {children}
            </pre>
          ),
          // Inline code
          code: ({ className, children, ...props }: ComponentPropsWithoutRef<"code">) => {
            // Check if this is a code block (has language class) or inline code
            const isCodeBlock = className?.includes("language-");
            if (isCodeBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-card text-foreground px-1.5 py-0.5 text-sm" {...props}>
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
            <div className="overflow-x-auto">
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
