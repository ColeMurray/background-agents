// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionHeader } from "./session-header";

expect.extend(matchers);

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({
    isOpen: true,
    toggle: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHeader(overrides: Partial<ComponentProps<typeof SessionHeader>> = {}) {
  return render(
    <SessionHeader
      sessionId="session-1"
      sessionStatus="active"
      artifacts={[]}
      primaryRepo={null}
      sessionState={null}
      fallbackSessionInfo={{ repoOwner: null, repoName: null, title: "Incident sweep" }}
      connected={false}
      connecting={true}
      isDetailsOpen={false}
      detailsButtonRef={createRef<HTMLButtonElement>()}
      mobileActionsButtonRef={createRef<HTMLButtonElement>()}
      onToggleDetails={vi.fn()}
      onOpenDetails={vi.fn()}
      onOpenMedia={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      renameSession={vi.fn()}
      {...overrides}
    />
  );
}

describe("SessionHeader", () => {
  it("renders no-repository fallback data as loaded while socket state is absent", () => {
    renderHeader();

    expect(screen.getByRole("button", { name: "Incident sweep" })).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.queryByText("Loading session...")).not.toBeInTheDocument();
  });

  it("uses a phone-only session actions menu and preserves the tablet details button classes", () => {
    renderHeader();

    expect(screen.getByRole("button", { name: "Toggle session details" })).toHaveClass(
      "hidden",
      "md:inline-flex",
      "lg:hidden"
    );
    expect(screen.getByRole("button", { name: "Session actions" })).toHaveClass("md:hidden");
  });

  it("renders the unified mobile actions in the required order", () => {
    renderHeader({
      artifacts: [
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
          url: "https://github.com/acme/web/pull/42",
          metadata: { prNumber: 42, repoOwner: "acme", repoName: "web" },
          createdAt: 1235,
        },
        {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-1.png",
          metadata: { mimeType: "image/png" },
          createdAt: 1236,
        },
      ],
      primaryRepo: { repoOwner: "acme", repoName: "web" },
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
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
  });

  it("calls the details and media callbacks from the unified phone menu", () => {
    const onOpenDetails = vi.fn();
    const onOpenMedia = vi.fn();
    renderHeader({
      onOpenDetails,
      onOpenMedia,
      artifacts: [
        {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-1.png",
          metadata: { mimeType: "image/png" },
          createdAt: 1236,
        },
      ],
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(onOpenDetails).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Media (1)" }));
    expect(onOpenMedia).toHaveBeenCalledOnce();
  });

  it("retains archive confirmation before archiving from the phone menu", () => {
    const onArchive = vi.fn();
    renderHeader({ onArchive });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(screen.getByText("Archive session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(onArchive).toHaveBeenCalledOnce();
  });

  it("unarchives directly from the phone menu when the session is already archived", async () => {
    let resolveUnarchive: (() => void) | undefined;
    const onUnarchive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnarchive = resolve;
        })
    );
    renderHeader({ sessionStatus: "archived", onUnarchive });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });
    const unarchiveItem = screen.getByRole("menuitem", { name: "Unarchive" });
    fireEvent.click(unarchiveItem);

    expect(onUnarchive).toHaveBeenCalledOnce();
    expect(screen.queryByText("Archive session")).not.toBeInTheDocument();

    resolveUnarchive?.();
  });
});
