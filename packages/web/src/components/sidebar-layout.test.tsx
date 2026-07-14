// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedSidebarControls, SidebarLayout } from "./sidebar-layout";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

expect.extend(matchers);

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: () => "/",
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/use-sidebar", () => ({
  useSidebar: () => ({
    isOpen: true,
    toggle: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  }),
}));

afterEach(cleanup);

describe("CollapsedSidebarControls", () => {
  it("renders the sidebar, search, and new session actions inline", () => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { name: "Test User" }, expires: "2099-01-01" },
      status: "authenticated",
      update: vi.fn(),
    });
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);

    render(
      <SidebarLayout>
        <CollapsedSidebarControls />
      </SidebarLayout>
    );

    const controls = screen.getByRole("button", { name: /Open sidebar/ }).parentElement;
    expect(controls).toHaveClass("flex", "items-center");
    const buttons = controls?.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(Array.from(buttons!, (button) => button.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Open sidebar/),
      expect.stringMatching(/^Search sessions/),
      expect.stringMatching(/^New session/),
    ]);

    fireEvent.click(buttons![2]);
    expect(push).toHaveBeenCalledWith("/");
  });
});
