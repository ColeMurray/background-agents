// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS_CATEGORY } from "./settings-nav";
import { SettingsShell } from "./settings-shell";
import { useSettingsIsMobile } from "./settings-viewport-context";
import { PERMISSION_IDS } from "@open-inspect/shared/rbac";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  isMobile: false,
  pathname: "",
  tab: "",
  permissions: [] as string[],
  replace: vi.fn(),
}));
const SHELL_FIXTURE_DEFAULTS = {
  isMobile: false,
  pathname: "/settings",
  tab: DEFAULT_SETTINGS_CATEGORY,
};

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn(), replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(`tab=${mocks.tab}`),
}));

vi.mock("@/lib/sandbox-provider", () => ({ supportsRepoImages: () => true }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { permissions: mocks.permissions },
    loading: false,
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
}));

beforeEach(() => {
  Object.assign(mocks, SHELL_FIXTURE_DEFAULTS);
  mocks.permissions = [...PERMISSION_IDS];
  mocks.replace.mockClear();
  vi.stubGlobal("matchMedia", () => ({
    matches: mocks.isMobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsShell", () => {
  it("renders only the mobile child tree on a fresh client mount", () => {
    mocks.isMobile = true;
    const viewports: boolean[] = [];
    const commits: string[] = [];
    function ViewportProbe() {
      viewports.push(useSettingsIsMobile());
      return null;
    }

    render(
      <Profiler id="settings" onRender={(_id, phase) => commits.push(phase)}>
        <SettingsShell>
          <ViewportProbe />
        </SettingsShell>
      </Profiler>
    );

    expect(viewports).toEqual([true]);
    expect(commits).toEqual(["mount"]);
    expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("hydrates the server placeholder without mounting a desktop tree on mobile", async () => {
    mocks.isMobile = true;
    const viewports: boolean[] = [];
    function ViewportProbe() {
      viewports.push(useSettingsIsMobile());
      return <span>Settings content</span>;
    }
    const shell = (
      <SettingsShell>
        <ViewportProbe />
      </SettingsShell>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(shell);
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(viewports).toEqual([]);
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot>;

    await act(async () => {
      root = hydrateRoot(container, shell, { onRecoverableError });
    });

    expect(viewports).toEqual([true]);
    expect(container.textContent).toBe("Settings content");
    expect(onRecoverableError).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("owns the desktop settings rail for nested routes", () => {
    mocks.pathname = "/settings/integrations/github";

    render(<SettingsShell>Integration settings</SettingsShell>);

    expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integrations" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText("Integration settings")).toBeInTheDocument();
  });

  it("provides the mobile viewport without rendering the desktop rail", () => {
    mocks.isMobile = true;

    const { container } = render(<SettingsShell>Mobile settings</SettingsShell>);

    expect(container.firstChild).toHaveClass("h-dvh", "overflow-hidden");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByText("Mobile settings")).toBeInTheDocument();
  });

  it("redirects an unauthorized nested settings route", () => {
    mocks.pathname = "/settings/integrations/github";
    mocks.permissions = [];

    render(<SettingsShell>Integration settings</SettingsShell>);

    expect(mocks.replace).toHaveBeenCalledWith("/settings?tab=appearance");
    expect(screen.queryByText("Integration settings")).not.toBeInTheDocument();
  });

  it("canonicalizes an unauthorized settings query to the rendered fallback", () => {
    mocks.pathname = "/settings";
    mocks.tab = "secrets";
    mocks.permissions = [];

    render(<SettingsShell>Secret settings</SettingsShell>);

    expect(mocks.replace).toHaveBeenCalledWith("/settings?tab=appearance");
    expect(screen.queryByText("Secret settings")).not.toBeInTheDocument();
  });
});
