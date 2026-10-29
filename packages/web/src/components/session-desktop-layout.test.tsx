// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDesktopLayout } from "./session-desktop-layout";

afterEach(cleanup);

describe("SessionDesktopLayout", () => {
  it("shows an open diff in the main column and keeps the details sidebar beside it", () => {
    render(
      <SessionDesktopLayout
        workspace={<main>timeline and terminal</main>}
        sidebar={<aside>details</aside>}
        changes={<section>changes</section>}
      />
    );

    expect(screen.getByText("changes")).toBeVisible();
    expect(screen.getByText("details")).toBeVisible();
    expect(screen.getByText("timeline and terminal")).not.toBeVisible();
  });

  it("shows the session workspace when no diff is open", () => {
    render(
      <SessionDesktopLayout
        workspace={<main>timeline and terminal</main>}
        sidebar={<aside>details</aside>}
        changes={null}
      />
    );

    expect(screen.getByText("timeline and terminal")).toBeVisible();
    expect(screen.getByText("details")).toBeVisible();
  });

  it("keeps the session workspace and sidebar mounted when a diff opens and closes", () => {
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
        changes={<section>changes</section>}
      />
    );
    expect(screen.getByText("timeline and terminal")).not.toBeVisible();
    rerender(
      <SessionDesktopLayout workspace={<Workspace />} sidebar={<Sidebar />} changes={null} />
    );
    expect(screen.getByText("timeline and terminal")).toBeVisible();

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(sidebarMounted).toHaveBeenCalledTimes(1);
    expect(sidebarUnmounted).not.toHaveBeenCalled();
  });
});
