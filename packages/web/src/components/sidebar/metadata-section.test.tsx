// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { MetadataSection } from "./metadata-section";
import type { Artifact } from "@/types/session";

expect.extend(matchers);

type SharedPrMetadata = NonNullable<Artifact["metadata"]> & {
  number?: number;
  state?: NonNullable<Artifact["metadata"]>["prState"];
};

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

describe("MetadataSection", () => {
  it("renders PR badge data from shared artifact metadata keys", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        artifacts={[
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              number: 42,
              state: "open",
            } as SharedPrMetadata,
            createdAt: 1234,
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "#42" })).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("keeps compatibility with legacy local PR metadata keys", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        artifacts={[
          {
            id: "artifact-pr-legacy",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/7",
            metadata: {
              prNumber: 7,
              prState: "draft",
            },
            createdAt: 1234,
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "#7" })).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
  });
});
