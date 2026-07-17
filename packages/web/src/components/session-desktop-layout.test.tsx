// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
}));

import { SessionDesktopLayout } from "./session-desktop-layout";

afterEach(cleanup);

describe("SessionDesktopLayout", () => {
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
