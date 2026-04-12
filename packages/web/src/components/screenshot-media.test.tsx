// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

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

    const image = screen.getByAltText("Dashboard after fix");
    fireEvent.load(image);
    expect(screen.getByAltText("Dashboard after fix")).toHaveAttribute(
      "src",
      "/api/sessions/session-1/media/artifact-1"
    );
    expect(screen.getByText("https://app.example.com/dashboard")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dashboard after fix" }));
    expect(onOpen).toHaveBeenCalledWith("artifact-1");
  });

  it("renders an unavailable state when the preview fails to load", () => {
    render(
      <ScreenshotArtifactCard
        sessionId="session-1"
        artifactId="artifact-1"
        metadata={{ caption: "Screenshot" }}
        onOpen={vi.fn()}
      />
    );

    fireEvent.error(screen.getByAltText("Screenshot"));
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
  });
});

describe("MediaLightbox", () => {
  it("renders the selected screenshot preview", () => {
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

    const image = screen.getByAltText("Checkout page");
    fireEvent.load(image);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Checkout page")).toBeInTheDocument();
    expect(screen.getByText("https://app.example.com/checkout")).toBeInTheDocument();
    expect(screen.getByAltText("Checkout page")).toHaveAttribute(
      "src",
      "/api/sessions/session-1/media/artifact-1"
    );
  });

  it("renders loading and empty states distinctly", () => {
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

  it("renders an unavailable state when the preview fails to load", () => {
    render(
      <MediaLightbox
        sessionId="session-1"
        artifact={{
          id: "artifact-1",
          type: "screenshot",
          url: null,
          metadata: { caption: "Broken shot" },
          createdAt: 1234,
        }}
        open={true}
        onOpenChange={vi.fn()}
      />
    );

    fireEvent.error(screen.getByAltText("Broken shot"));
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
  });
});

describe("MediaSection", () => {
  it("renders nothing when there are no screenshots", () => {
    const onOpenMedia = vi.fn();
    const { container } = render(
      <MediaSection sessionId="session-1" screenshots={[]} onOpenMedia={onOpenMedia} />
    );

    expect(container.firstChild).toBeNull();
    expect(onOpenMedia).not.toHaveBeenCalled();
  });

  it("renders one card per screenshot and hides source URLs in compact mode", () => {
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

    fireEvent.load(screen.getByAltText("Sidebar shot"));
    fireEvent.click(screen.getByRole("button", { name: "Sidebar shot" }));
    expect(onOpenMedia).toHaveBeenCalledWith("artifact-1");
    expect(screen.queryByText("https://app.example.com/sidebar")).not.toBeInTheDocument();
  });
});
