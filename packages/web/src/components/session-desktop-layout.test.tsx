// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type * as ResizablePanels from "react-resizable-panels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-resizable-panels", async (importOriginal) => {
  const actual = await importOriginal<typeof ResizablePanels>();
  return {
    ...actual,
    Panel: ({ defaultSize, ...props }: React.ComponentProps<typeof actual.Panel>) => (
      <actual.Panel {...props} defaultSize={defaultSize} data-default-size={defaultSize} />
    ),
  };
});

import { SESSION_CHANGES_LAYOUT_ID, SessionDesktopLayout } from "./session-desktop-layout";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SessionDesktopLayout", () => {
  it("gives the changes panel most of the workspace when it opens", () => {
    render(
      <SessionDesktopLayout
        workspace={<main>timeline and terminal</main>}
        sidebar={<aside>details</aside>}
        changes={<aside>changes</aside>}
      />
    );

    expect(screen.getByTestId("session-main")).toHaveAttribute("data-default-size", "45%");
    expect(screen.getByTestId("session-changes")).toHaveAttribute("data-default-size", "55%");
    expect(screen.getByText("details")).toBeInTheDocument();
  });

  it("clips overflow on the real panel group and nested content wrapper", () => {
    render(
      <SessionDesktopLayout
        workspace={<main>timeline and terminal</main>}
        sidebar={<aside>details</aside>}
        changes={null}
      />
    );

    expect(screen.getByTestId(SESSION_CHANGES_LAYOUT_ID)).toHaveStyle({ overflow: "clip" });
    expect(screen.getByTestId("session-main").firstElementChild).toHaveStyle({
      minWidth: "0",
      minHeight: "0",
      overflow: "clip",
    });
  });

  it("keeps the session workspace mounted when the changes panel opens and closes", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const sidebarMounted = vi.fn();
    const sidebarUnmounted = vi.fn();

    function Workspace() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div>timeline and terminal</div>;
    }

    function Sidebar() {
      useEffect(() => {
        sidebarMounted();
        return sidebarUnmounted;
      }, []);
      return <aside>details</aside>;
    }

    const { rerender } = render(
      <SessionDesktopLayout workspace={<Workspace />} sidebar={<Sidebar />} changes={null} />
    );

    rerender(
      <SessionDesktopLayout
        workspace={<Workspace />}
        sidebar={<Sidebar />}
        changes={<aside>changes</aside>}
      />
    );
    rerender(
      <SessionDesktopLayout workspace={<Workspace />} sidebar={<Sidebar />} changes={null} />
    );

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(sidebarMounted).toHaveBeenCalledTimes(1);
    expect(sidebarUnmounted).not.toHaveBeenCalled();
  });
});
