// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { MetadataSection } from "./metadata-section";

expect.extend(matchers);

// This suite renders into a shared document.body without vitest globals/auto-
// cleanup, so unmount between cases to keep queries (e.g. PR state badges) from
// matching leftover DOM from earlier renders.
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

describe("MetadataSection", () => {
  it("renders PR badge data from artifact metadata keys", () => {
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
              prNumber: 42,
              prState: "open",
            },
            createdAt: 1234,
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "#42" })).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("renders an explicit no-repository row for repo-less sessions", () => {
    render(
      <MetadataSection createdAt={Date.now()} baseBranch={null} repoOwner={null} repoName={null} />
    );

    expect(screen.getByText("No repository")).toBeInTheDocument();
  });

  function member(repoOwner: string, repoName: string, position: number) {
    return {
      position,
      repoOwner,
      repoName,
      repoId: position + 1,
      baseBranch: "main",
      branchName: null,
      baseSha: null,
      currentSha: null,
      prUrl: null,
    };
  }

  it("renders a per-repo member list with per-repo PR chips matched by artifact metadata", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        repositories={[member("acme", "web", 0), member("acme", "api", 1)]}
        artifacts={[
          {
            id: "pr-web",
            type: "pr",
            url: "https://github.com/acme/web/pull/1",
            metadata: { prNumber: 1, prState: "open", repoOwner: "acme", repoName: "web" },
            createdAt: 1,
          },
          {
            id: "pr-api",
            type: "pr",
            url: "https://github.com/acme/api/pull/2",
            metadata: { prNumber: 2, prState: "merged", repoOwner: "acme", repoName: "api" },
            createdAt: 2,
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "acme/web" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "acme/api" })).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#2" })).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("merged")).toBeInTheDocument();
  });

  it("attributes an identity-less PR artifact to the primary member only", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        repositories={[member("acme", "web", 0), member("acme", "api", 1)]}
        artifacts={[
          {
            id: "pr-legacy",
            type: "pr",
            url: "https://github.com/acme/web/pull/7",
            metadata: { prNumber: 7, prState: "open" },
            createdAt: 1,
          },
        ]}
      />
    );

    // The identity-less PR belongs to the primary, so it renders exactly once.
    expect(screen.getAllByRole("link", { name: "#7" })).toHaveLength(1);
  });

  it("renders non-fatal warnings with repo attribution", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        warnings={[
          {
            type: "warning",
            scope: "secrets",
            message: "Secret key collision on API_KEY",
            repoOwner: "acme",
            repoName: "api",
            timestamp: 1,
          },
        ]}
      />
    );

    expect(screen.getByText("acme/api: Secret key collision on API_KEY")).toBeInTheDocument();
  });
});
