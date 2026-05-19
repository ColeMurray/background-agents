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
