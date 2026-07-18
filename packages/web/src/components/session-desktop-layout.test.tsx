// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({
    children,
    id,
    defaultSize,
  }: {
    children: React.ReactNode;
    id: string;
    defaultSize: string;
  }) => (
    <div data-testid={id} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  Separator: () => <div />,
}));

import { SessionDesktopLayout } from "./session-desktop-layout";

afterEach(cleanup);

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
  });

  it("keeps the session workspace mounted when the changes panel opens and closes", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();

    function Workspace() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div>timeline and terminal</div>;
    }

    const { rerender } = render(
      <SessionDesktopLayout
        workspace={<Workspace />}
        sidebar={<aside>details</aside>}
        changes={null}
      />
    );

    rerender(
      <SessionDesktopLayout
        workspace={<Workspace />}
        sidebar={<aside>details</aside>}
        changes={<aside>changes</aside>}
      />
    );
    rerender(
      <SessionDesktopLayout
        workspace={<Workspace />}
        sidebar={<aside>details</aside>}
        changes={null}
      />
    );

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });
});
