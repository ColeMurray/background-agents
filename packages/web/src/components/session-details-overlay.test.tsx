// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionDetailsOverlay } from "./session-details-overlay";
import type { SessionCapabilities } from "@/lib/session-capabilities";

vi.mock("./session-right-sidebar", () => ({
  SessionRightSidebarContent: () => <p>Run information</p>,
}));
afterEach(cleanup);

it.each([true, false])("hides closed details from assistive technology (phone=%s)", (isPhone) => {
  const onOpenChange = vi.fn();
  const onReturnFocus = vi.fn();
  const props = {
    isPhone,
    onOpenChange,
    onReturnFocus,
    sessionId: "session-1",
    sessionState: null,
    participants: [],
    presenceSynced: true,
    events: [],
    artifacts: [],
    onOpenMedia: vi.fn(),
    capabilities: {
      read: true,
      collaborate: true,
      lifecycle: true,
      delete: false,
      manageCollaborators: false,
      changeVisibility: false,
      sandboxAccess: false,
      exportTrace: false,
    } satisfies SessionCapabilities,
    activeTab: "changes" as const,
    onTabChange: vi.fn(),
  };
  const view = render(<SessionDetailsOverlay {...props} open={false} />);
  expect(screen.queryByRole("dialog", { name: "Session details" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Close session details" })).not.toBeInTheDocument();

  view.rerender(<SessionDetailsOverlay {...props} open />);
  expect(screen.getByRole("dialog", { name: "Session details" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

  const handledEscape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  handledEscape.preventDefault();
  fireEvent(screen.getByRole("button", { name: "Close" }), handledEscape);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onReturnFocus).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onReturnFocus).toHaveBeenCalledOnce();

  view.rerender(<SessionDetailsOverlay {...props} open={false} />);
  expect(screen.queryByRole("dialog", { name: "Session details" })).not.toBeInTheDocument();
});
