// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("renders every PR for a single-repo session, oldest first", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        artifacts={[
          {
            id: "pr-newer",
            type: "pr",
            url: "https://github.com/acme/web/pull/12",
            metadata: { prNumber: 12, prState: "open" },
            createdAt: 2,
          },
          {
            id: "pr-older",
            type: "pr",
            url: "https://github.com/acme/web/pull/7",
            metadata: { prNumber: 7, prState: "merged" },
            createdAt: 1,
          },
        ]}
      />
    );

    const prLinks = screen.getAllByRole("link", { name: /^#\d+$/ });
    expect(prLinks.map((link) => link.textContent)).toEqual(["#7", "#12"]);
    expect(screen.getByText("merged")).toBeInTheDocument();
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

  it("renders every PR chip for a member holding several PRs", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        repositories={[member("acme", "web", 0), member("acme", "api", 1)]}
        artifacts={[
          {
            id: "pr-web-1",
            type: "pr",
            url: "https://github.com/acme/web/pull/1",
            metadata: { prNumber: 1, prState: "merged", repoOwner: "acme", repoName: "web" },
            createdAt: 1,
          },
          {
            id: "pr-web-2",
            type: "pr",
            url: "https://github.com/acme/web/pull/3",
            metadata: { prNumber: 3, prState: "open", repoOwner: "acme", repoName: "web" },
            createdAt: 3,
          },
          {
            id: "pr-api",
            type: "pr",
            url: "https://github.com/acme/api/pull/2",
            metadata: { prNumber: 2, prState: "open", repoOwner: "acme", repoName: "api" },
            createdAt: 2,
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "#1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#3" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#2" })).toBeInTheDocument();
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

  it("renders the environment name for environment-launched sessions", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        environmentId="env-1"
        environmentName="full-stack"
      />
    );

    expect(screen.getByText("full-stack")).toBeInTheDocument();
    expect(screen.queryByText("Environment deleted")).not.toBeInTheDocument();
  });

  it("renders the deleted state when the environment name resolves null", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        environmentId="env-1"
        environmentName={null}
      />
    );

    expect(screen.getByText("Environment deleted")).toBeInTheDocument();
  });

  it("renders no environment row for repo-launched sessions", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        repoOwner="acme"
        repoName="web"
        environmentId={null}
        environmentName={null}
      />
    );

    expect(screen.queryByText("Environment deleted")).not.toBeInTheDocument();
  });
});

describe("PR sync button", () => {
  const prArtifact = {
    id: "artifact-pr-1",
    type: "pr" as const,
    url: "https://github.com/acme/web-app/pull/42",
    metadata: { prNumber: 42, prState: "open" as const },
    createdAt: 1234,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kicks the refresh endpoint when clicked", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "refreshing" })));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MetadataSection
        sessionId="session-1"
        createdAt={Date.now()}
        baseBranch="main"
        artifacts={[prArtifact]}
      />
    );

    const button = screen.getByRole("button", { name: "Sync PR status" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/pull-requests/refresh", {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
      });
    });
  });

  it("moves to a Pull requests header covering every row when several PRs exist", () => {
    render(
      <MetadataSection
        sessionId="session-1"
        createdAt={Date.now()}
        baseBranch="main"
        artifacts={[
          prArtifact,
          {
            id: "artifact-pr-2",
            type: "pr" as const,
            url: "https://github.com/acme/web-app/pull/43",
            metadata: { prNumber: 43, prState: "merged" as const, head: "feat/second" },
            createdAt: 1235,
          },
        ]}
      />
    );

    // One button for the whole section, not one pinned to the first row.
    const buttons = screen.getAllByRole("button", { name: "Sync PR status" });
    expect(buttons).toHaveLength(1);
    const header = screen.getByText("Pull requests");
    expect(header.parentElement).toContainElement(buttons[0]);
    // Rows carry their head branch so several PRs stay distinguishable.
    expect(screen.getByText("feat/second")).toBeInTheDocument();
  });

  it("does not render without a sessionId or without PR artifacts", () => {
    render(<MetadataSection createdAt={Date.now()} baseBranch="main" artifacts={[prArtifact]} />);
    expect(screen.queryByRole("button", { name: "Sync PR status" })).not.toBeInTheDocument();
    cleanup();

    render(
      <MetadataSection
        sessionId="session-1"
        createdAt={Date.now()}
        baseBranch="main"
        artifacts={[]}
      />
    );
    expect(screen.queryByRole("button", { name: "Sync PR status" })).not.toBeInTheDocument();
  });
});
