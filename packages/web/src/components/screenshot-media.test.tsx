// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

const { mockUseMediaArtifactUrl } = vi.hoisted(() => ({
  mockUseMediaArtifactUrl: vi.fn(),
}));

vi.mock("@/hooks/use-media-artifact-url", () => ({
  useMediaArtifactUrl: mockUseMediaArtifactUrl,
}));

import { MediaLightbox } from "./media-lightbox";
import { ScreenshotArtifactCard } from "./screenshot-artifact-card";
import { MediaSection } from "./sidebar/media-section";

expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ScreenshotArtifactCard", () => {
  it("renders the screenshot preview and opens the selected artifact", () => {
    mockUseMediaArtifactUrl.mockReturnValue({
      url: "https://media.example.com/artifact.png",
      isLoading: false,
    });
    const onOpen = vi.fn();

    render(
      <ScreenshotArtifactCard
        sessionId="session-1"
        artifactId="artifact-1"
        metadata={{
          caption: "Dashboard after fix",
          sourceUrl: "https://app.example.com/dashboard",
        }}
        onOpen={onOpen}
      />
    );

    expect(screen.getByRole("img", { name: "Dashboard after fix" })).toHaveAttribute(
      "src",
      "https://media.example.com/artifact.png"
    );
    expect(screen.getByText("https://app.example.com/dashboard")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dashboard after fix" }));
    expect(onOpen).toHaveBeenCalledWith("artifact-1");
  });

  it("renders an unavailable state when no URL is returned", () => {
    mockUseMediaArtifactUrl.mockReturnValue({
      url: null,
      isLoading: false,
    });

    render(
      <ScreenshotArtifactCard
        sessionId="session-1"
        artifactId="artifact-1"
        metadata={{ caption: "Screenshot" }}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
  });
});

describe("MediaLightbox", () => {
  it("renders the selected screenshot preview", () => {
    mockUseMediaArtifactUrl.mockReturnValue({
      url: "https://media.example.com/lightbox.png",
      isLoading: false,
    });

    render(
      <MediaLightbox
        sessionId="session-1"
        artifact={{
          id: "artifact-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-1.png",
          metadata: {
            caption: "Checkout page",
            sourceUrl: "https://app.example.com/checkout",
          },
          createdAt: 1234,
        }}
        open={true}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Checkout page")).toBeInTheDocument();
    expect(screen.getByText("https://app.example.com/checkout")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Checkout page" })).toHaveAttribute(
      "src",
      "https://media.example.com/lightbox.png"
    );
  });

  it("renders loading and empty states distinctly", () => {
    mockUseMediaArtifactUrl.mockReturnValue({
      url: null,
      isLoading: true,
    });

    const { rerender } = render(
      <MediaLightbox sessionId="session-1" artifact={null} open={true} onOpenChange={vi.fn()} />
    );

    expect(screen.getByText("No screenshot selected")).toBeInTheDocument();

    rerender(
      <MediaLightbox
        sessionId="session-1"
        artifact={{
          id: "artifact-1",
          type: "screenshot",
          url: null,
          metadata: { caption: "Loading shot" },
          createdAt: 1234,
        }}
        open={true}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.getByText("Loading screenshot...")).toBeInTheDocument();
  });
});

describe("MediaSection", () => {
  it("renders one card per screenshot and hides source URLs in compact mode", () => {
    mockUseMediaArtifactUrl.mockReturnValue({
      url: "https://media.example.com/sidebar.png",
      isLoading: false,
    });
    const onOpenMedia = vi.fn();

    render(
      <MediaSection
        sessionId="session-1"
        screenshots={[
          {
            id: "artifact-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-1.png",
            metadata: {
              caption: "Sidebar shot",
              sourceUrl: "https://app.example.com/sidebar",
            },
            createdAt: 1234,
          },
        ]}
        onOpenMedia={onOpenMedia}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sidebar shot" }));
    expect(onOpenMedia).toHaveBeenCalledWith("artifact-1");
    expect(screen.queryByText("https://app.example.com/sidebar")).not.toBeInTheDocument();
  });
});
