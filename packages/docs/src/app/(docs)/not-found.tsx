import type { Metadata } from "next";
import Link from "next/link";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";

import { sectionLinks } from "@/lib/sections";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function DocumentationNotFound() {
  const sections = sectionLinks(source.getPageTree());

  return (
    <DocsPage breadcrumb={{ enabled: false }} footer={{ enabled: false }}>
      <p className="text-sm font-medium text-fd-muted-foreground">404</p>
      <DocsTitle>Page not found</DocsTitle>
      <DocsDescription>The page you asked for does not exist or has moved.</DocsDescription>
      <DocsBody>
        <p>
          Search the documentation with <kbd>⌘</kbd> <kbd>K</kbd> on macOS or <kbd>Ctrl</kbd>{" "}
          <kbd>K</kbd> on Windows and Linux, or start from one of these sections.
        </p>
        <ul>
          <li>
            <Link href="/">Documentation home</Link>
          </li>
          {sections.map((section) => (
            <li key={section.url}>
              <Link href={section.url}>{section.name}</Link>
            </li>
          ))}
        </ul>
      </DocsBody>
    </DocsPage>
  );
}
