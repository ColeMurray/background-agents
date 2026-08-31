// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS_CATEGORY } from "./settings-nav";
import { SettingsShell } from "./settings-shell";
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

vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => mocks.isMobile }));
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
});

afterEach(() => {
  cleanup();
});

describe("SettingsShell", () => {
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
