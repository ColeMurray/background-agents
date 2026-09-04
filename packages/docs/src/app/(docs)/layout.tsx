import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { baseOptions } from "@/lib/layout";
import { source } from "@/lib/source";

export default function DocumentationLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
