import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { Logo } from "@/components/logo";
import { site } from "@/lib/site";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      url: "/",
      transparentMode: "none",
    },
    githubUrl: site.repositoryUrl,
    links: [
      {
        text: "Product",
        url: site.productUrl,
        external: true,
      },
      {
        text: "Get started",
        url: `${site.productUrl}/#contact`,
        external: true,
        type: "button",
      },
    ],
  };
}
