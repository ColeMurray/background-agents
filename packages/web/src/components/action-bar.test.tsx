// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { ActionBar } from "./action-bar";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("ActionBar", () => {
  it("renders View PR for hydrated PR artifacts", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        artifacts={[
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              prNumber: 42,
              prState: "open",
              head: "feature/test",
              base: "main",
            },
            createdAt: 1234,
          },
        ]}
      />
    );

    const link = screen.getByRole("link", { name: /view pr/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/web-app/pull/42");
  });

  it("renders a media count indicator when screenshots or videos exist", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        artifacts={[
          {
            id: "artifact-shot-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-1.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-1.png",
              mimeType: "image/png",
              sizeBytes: 128,
            },
            createdAt: 1234,
          },
          {
            id: "artifact-shot-2",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-2.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-2.png",
              mimeType: "image/png",
              sizeBytes: 256,
            },
            createdAt: 1235,
          },
          {
            id: "artifact-video-1",
            type: "video",
            url: "sessions/session-1/media/artifact-video-1.mp4",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-video-1.mp4",
              mimeType: "video/mp4",
              sizeBytes: 2048,
            },
            createdAt: 1236,
          },
        ]}
      />
    );

    expect(screen.getByText("Media (3)")).toBeInTheDocument();
  });

  it("does not render a media count indicator when no media artifacts exist", () => {
    render(<ActionBar sessionId="session-1" sessionStatus="active" artifacts={[]} />);

    expect(screen.queryByText(/Media/)).not.toBeInTheDocument();
  });
});

describe("repository-aware PR selection", () => {
  const webPr = {
    id: "artifact-pr-web",
    type: "pr" as const,
    url: "https://github.com/acme/web/pull/1",
    metadata: { prNumber: 1, repoOwner: "acme", repoName: "web" },
    createdAt: 1,
  };
  const backendPr = {
    id: "artifact-pr-backend",
    type: "pr" as const,
    url: "https://github.com/acme/backend/pull/9",
    metadata: { prNumber: 9, repoOwner: "acme", repoName: "backend" },
    createdAt: 2,
  };

  it("selects the primary repo's PR, not the first PR artifact", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        artifacts={[backendPr, webPr]}
        primaryRepo={{ repoOwner: "acme", repoName: "web" }}
      />
    );

    const link = screen.getByRole("link", { name: /view pr/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/web/pull/1");
  });

  it("falls back to the first PR artifact without repo context", () => {
    render(
      <ActionBar sessionId="session-1" sessionStatus="active" artifacts={[backendPr, webPr]} />
    );

    const link = screen.getByRole("link", { name: /view pr/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/backend/pull/9");
  });
});
