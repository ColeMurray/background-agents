// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { ActionBar } from "./action-bar";
import { MobileSessionActions } from "./mobile-session-actions";
import type { SessionCapabilities } from "@/lib/session-capabilities";

const FULL_CAPABILITIES = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
} satisfies SessionCapabilities;
const NO_LIFECYCLE = { ...FULL_CAPABILITIES, lifecycle: false };

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("ActionBar", () => {
  it("hides lifecycle actions when the capability is denied", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        artifacts={[]}
        capabilities={NO_LIFECYCLE}
      />
    );

    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More session actions" })).toBeInTheDocument();
  });

  it("renders View PR for hydrated PR artifacts", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        capabilities={FULL_CAPABILITIES}
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
        capabilities={FULL_CAPABILITIES}
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
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        artifacts={[]}
        capabilities={FULL_CAPABILITIES}
      />
    );

    expect(screen.queryByText(/Media/)).not.toBeInTheDocument();
  });

  it("consolidates all session actions into the menu on mobile", () => {
    const onOpenDetails = vi.fn();
    const onOpenMedia = vi.fn();
    render(
      <MobileSessionActions
        sessionId="session-1"
        sessionStatus="active"
        capabilities={FULL_CAPABILITIES}
        artifacts={[
          {
            id: "artifact-preview-1",
            type: "preview",
            url: "https://preview.example.com",
            metadata: { previewStatus: "active" },
            createdAt: 1234,
          },
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: { prNumber: 42 },
            createdAt: 1235,
          },
          {
            id: "artifact-shot-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-1.png",
            metadata: { mimeType: "image/png" },
            createdAt: 1236,
          },
        ]}
        onOpenDetails={onOpenDetails}
        onOpenMedia={onOpenMedia}
        triggerRef={{ current: null }}
      />
    );

    const trigger = screen.getByRole("button", { name: "Session actions" });
    expect(trigger.parentElement).toHaveClass("md:hidden");
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Details",
      "View preview",
      "View PR",
      "Media (1)",
      "Copy link",
      "Archive",
    ]);
    expect(screen.getByRole("separator")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(onOpenDetails).toHaveBeenCalledOnce();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Media (1)" }));
    expect(onOpenMedia).toHaveBeenCalledOnce();
  });

  it("confirms archive and keeps the action pending until the callback settles", async () => {
    let resolveArchive: (() => void) | undefined;
    const onArchive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveArchive = resolve;
        })
    );
    render(
      <MobileSessionActions
        sessionId="session-1"
        sessionStatus="active"
        capabilities={FULL_CAPABILITIES}
        artifacts={[]}
        onArchive={onArchive}
        onOpenDetails={vi.fn()}
        onOpenMedia={vi.fn()}
        triggerRef={{ current: null }}
      />
    );

    const trigger = screen.getByRole("button", { name: "Session actions" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledOnce();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveAttribute("data-disabled");

    resolveArchive?.();
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Archive" })).not.toHaveAttribute("data-disabled")
    );
  });
});

describe("multi-PR sessions", () => {
  const webPr = {
    id: "artifact-pr-web",
    type: "pr" as const,
    url: "https://github.com/acme/web/pull/1",
    metadata: {
      prNumber: 1,
      prState: "merged" as const,
      head: "feat/first",
      repoOwner: "acme",
      repoName: "web",
    },
    createdAt: 1,
  };
  const backendPr = {
    id: "artifact-pr-backend",
    type: "pr" as const,
    url: "https://github.com/acme/backend/pull/9",
    metadata: {
      prNumber: 9,
      prState: "open" as const,
      head: "feat/second",
      repoOwner: "acme",
      repoName: "backend",
    },
    createdAt: 2,
  };

  it("lists every PR in a picker, labeling PRs outside the primary repo", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        capabilities={FULL_CAPABILITIES}
        artifacts={[backendPr, webPr]}
        primaryRepo={{ repoOwner: "acme", repoName: "web" }}
      />
    );

    expect(screen.queryByRole("link", { name: /view pr/i })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: /view prs \(2\)/i }), {
      button: 0,
      ctrlKey: false,
    });

    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "#1 · feat/firstmerged",
      "acme/backend#9 · feat/secondopen",
    ]);
    expect(items[0]).toHaveAttribute("href", "https://github.com/acme/web/pull/1");
    expect(items[1]).toHaveAttribute("href", "https://github.com/acme/backend/pull/9");
  });

  it("drops the More-menu GitHub link when several PRs exist", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        capabilities={FULL_CAPABILITIES}
        artifacts={[backendPr, webPr]}
        primaryRepo={{ repoOwner: "acme", repoName: "web" }}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "More session actions" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "View in GitHub" })).not.toBeInTheDocument();
  });

  it("lists every PR in the mobile menu", () => {
    render(
      <MobileSessionActions
        sessionId="session-1"
        sessionStatus="active"
        capabilities={FULL_CAPABILITIES}
        artifacts={[backendPr, webPr]}
        primaryRepo={{ repoOwner: "acme", repoName: "web" }}
        onOpenDetails={vi.fn()}
        onOpenMedia={vi.fn()}
        triggerRef={{ current: null }}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });

    const prItems = screen
      .getAllByRole("menuitem")
      .filter((item) => item.getAttribute("href")?.includes("/pull/"));
    expect(prItems.map((item) => item.textContent)).toEqual([
      "#1 · feat/firstmerged",
      "acme/backend#9 · feat/secondopen",
    ]);
  });
});
