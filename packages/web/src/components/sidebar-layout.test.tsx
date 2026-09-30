// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedSidebarControls, SidebarLayout } from "./sidebar-layout";
import { useRouter } from "next/navigation";
import type * as SWR from "swr";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  isMobile: false,
  canCreateSession: true,
  activeTeamId: null as string | null,
  scope: "workspace" as "workspace" | "all" | undefined,
  setActiveTeam: vi.fn(),
  teamLoading: false,
  teamError: undefined as unknown,
  useSWR: vi.fn((_key: unknown, _fetcher?: unknown) => ({ data: undefined })),
  commandMenu: vi.fn((_props: unknown) => null),
  sidebar: {
    isOpen: true,
    toggle: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("./global-command-menu", () => ({ GlobalCommandMenu: mocks.commandMenu }));

vi.mock("swr", async (importOriginal) => ({
  ...(await importOriginal<typeof SWR>()),
  default: mocks.useSWR,
}));

vi.mock("@/hooks/use-active-team", () => ({
  useActiveTeam: () => ({
    activeTeamId: mocks.activeTeamId,
    setActiveTeam: mocks.setActiveTeam,
    teams: [],
    scope: mocks.scope,
    requireTeamOnCreate: false,
    loading: mocks.teamLoading,
    error: mocks.teamError,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: () => "/",
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => mocks.isMobile,
}));

vi.mock("@/hooks/use-sidebar", () => ({
  useSidebar: () => mocks.sidebar,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission === "sessions.create" && mocks.canCreateSession,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.isMobile = false;
  mocks.canCreateSession = true;
  mocks.sidebar.isOpen = true;
  mocks.activeTeamId = null;
  mocks.scope = "workspace";
  mocks.teamLoading = false;
  mocks.teamError = undefined;
});

describe("command-menu recent session scope", () => {
  it.each([
    { label: "Workspace", activeTeamId: null, scope: "workspace", suffix: "scope=workspace" },
    {
      label: "Alpha",
      activeTeamId: "team_alpha",
      scope: undefined,
      suffix: "teamIds%5B%5D=team_alpha",
    },
    { label: "All teams", activeTeamId: null, scope: "all", suffix: "scope=all" },
    { label: "All my teams", activeTeamId: null, scope: undefined, suffix: "" },
  ] as const)(
    "scopes recent requests for $label using the existing key",
    ({ activeTeamId, scope, suffix }) => {
      mocks.activeTeamId = activeTeamId;
      mocks.scope = scope;
      vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
      render(
        <SidebarLayout>
          <CollapsedSidebarControls />
        </SidebarLayout>
      );
      fireEvent.click(screen.getAllByRole("button", { name: /Quick search recent sessions/ })[0]);
      expect(mocks.useSWR).toHaveBeenCalledWith(
        `/api/sessions?limit=100&offset=0&excludeStatus=archived${suffix ? `&${suffix}` : ""}`,
        expect.any(Function)
      );
      expect(mocks.commandMenu).toHaveBeenLastCalledWith(
        expect.objectContaining({
          teamContext: {
            teamIds: activeTeamId ? [activeTeamId] : undefined,
            scope,
          },
        }),
        undefined
      );
    }
  );

  it("changes the recent cache key when the active context changes", () => {
    mocks.activeTeamId = "team_alpha";
    mocks.scope = undefined;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    const { rerender } = render(
      <SidebarLayout>
        <CollapsedSidebarControls />
      </SidebarLayout>
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Quick search recent sessions/ })[0]);
    mocks.useSWR.mockClear();
    mocks.activeTeamId = "team_beta";
    rerender(
      <SidebarLayout>
        <CollapsedSidebarControls />
      </SidebarLayout>
    );
    expect(mocks.useSWR).toHaveBeenCalledWith(
      "/api/sessions?limit=100&offset=0&excludeStatus=archived&teamIds%5B%5D=team_beta",
      expect.any(Function)
    );
  });

  it.each([
    ["workspace", "all"],
    ["workspace", undefined],
    ["all", "workspace"],
    ["all", undefined],
    [undefined, "workspace"],
    [undefined, "all"],
  ] as const)(
    "updates recent requests and the command handoff for scope-only switch %s -> %s",
    (previousScope, nextScope) => {
      mocks.scope = previousScope;
      vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
      const { rerender } = render(
        <SidebarLayout>
          <CollapsedSidebarControls />
        </SidebarLayout>
      );
      fireEvent.click(screen.getAllByRole("button", { name: /Quick search recent sessions/ })[0]);
      mocks.useSWR.mockClear();
      mocks.scope = nextScope;
      rerender(
        <SidebarLayout>
          <CollapsedSidebarControls />
        </SidebarLayout>
      );

      expect(mocks.activeTeamId).toBeNull();
      expect(mocks.useSWR).toHaveBeenCalledWith(
        `/api/sessions?limit=100&offset=0&excludeStatus=archived${nextScope ? `&scope=${nextScope}` : ""}`,
        expect.any(Function)
      );
      expect(mocks.commandMenu).toHaveBeenLastCalledWith(
        expect.objectContaining({
          open: true,
          teamContext: { teamIds: undefined, scope: nextScope },
        }),
        undefined
      );
    }
  );

  it.each(["loading", "error"])(
    "does not fetch an unscoped fallback while team context has %s",
    (state) => {
      mocks.teamLoading = state === "loading";
      mocks.teamError = state === "error" ? new Error("teams failed") : undefined;
      vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
      render(
        <SidebarLayout>
          <CollapsedSidebarControls />
        </SidebarLayout>
      );
      fireEvent.click(screen.getAllByRole("button", { name: /Quick search recent sessions/ })[0]);
      expect(
        mocks.useSWR.mock.calls.some(
          ([key]) => typeof key === "string" && key.startsWith("/api/sessions?limit=100")
        )
      ).toBe(false);
    }
  );
});

describe("CollapsedSidebarControls", () => {
  it("renders the sidebar, search, and new session actions inline", () => {
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
      expect.stringMatching(/^Quick search recent sessions/),
      expect.stringMatching(/^New session/),
    ]);

    fireEvent.click(buttons![2]);
    expect(push).toHaveBeenCalledWith("/");
  });

  it("hides the new session action without session creation permission", () => {
    mocks.canCreateSession = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(
      <SidebarLayout>
        <CollapsedSidebarControls />
      </SidebarLayout>
    );

    expect(screen.queryByRole("button", { name: /New session/ })).not.toBeInTheDocument();
  });
});

describe("mobile sidebar drag", () => {
  it("opens after swiping right from the inset activation zone", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(<SidebarLayout>Session</SidebarLayout>);

    vi.spyOn(screen.getByTestId("mobile-sidebar-drawer"), "getBoundingClientRect").mockReturnValue({
      width: 288,
    } as DOMRect);
    const gestureBoundary = screen.getByTestId("mobile-sidebar-gesture-boundary");
    expect(gestureBoundary).toHaveClass("touch-pan-y");
    fireEvent.pointerDown(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 124,
      clientY: 202,
    });
    fireEvent.pointerUp(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 124,
      clientY: 202,
    });

    expect(mocks.sidebar.open).toHaveBeenCalledOnce();
  });

  it("does not open when the swipe is too short", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(<SidebarLayout>Session</SidebarLayout>);

    vi.spyOn(screen.getByTestId("mobile-sidebar-drawer"), "getBoundingClientRect").mockReturnValue({
      width: 288,
    } as DOMRect);
    const gestureBoundary = screen.getByTestId("mobile-sidebar-gesture-boundary");
    fireEvent.pointerDown(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 74,
      clientY: 200,
    });
    fireEvent.pointerUp(gestureBoundary, { pointerId: 1, pointerType: "touch" });

    expect(mocks.sidebar.open).not.toHaveBeenCalled();
  });

  it("delivers taps in the activation zone to underlying content", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    const onPointerDown = vi.fn();
    const onClick = vi.fn();

    render(
      <SidebarLayout>
        <button onPointerDown={onPointerDown} onClick={onClick}>
          Content action
        </button>
      </SidebarLayout>
    );

    const contentAction = screen.getByRole("button", { name: "Content action" });
    fireEvent.pointerDown(contentAction, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerUp(contentAction, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.click(contentAction);

    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
    expect(mocks.sidebar.open).not.toHaveBeenCalled();
  });
});
