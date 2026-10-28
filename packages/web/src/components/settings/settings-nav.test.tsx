// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsNav } from "./settings-nav";
import { SettingsViewportProvider } from "./settings-viewport-context";
import { resolveSettingsCategory } from "./settings-registry";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import { SettingsMobileHeader } from "./settings-mobile-header";
import {
  SettingsNavigationGuardProvider,
  useSettingsUnsavedChanges,
} from "./settings-navigation-guard";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  isMobile: false,
  repoImagesEnabled: true,
  allowedPermissions: null as Set<string> | null,
  canEditTeam: false,
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.repoImagesEnabled,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      mocks.allowedPermissions === null || mocks.allowedPermissions.has(permission),
  }),
}));
vi.mock("@/hooks/use-teams", () => ({
  useMeTeams: () => ({
    teams: mocks.canEditTeam ? [{ capabilities: { canEditMetadata: true } }] : [],
    loading: false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.isMobile = false;
  mocks.repoImagesEnabled = true;
  mocks.allowedPermissions = null;
  mocks.canEditTeam = false;
});

describe("Settings exit links", () => {
  it.each(["Back to app", "Close settings"])(
    "guards %s without blocking modifier or new-tab clicks",
    (label) => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const router = {
        route: "/settings",
        pathname: "/settings",
        query: {},
        asPath: "/settings?tab=workspace",
        basePath: "",
        isLocaleDomain: false,
        isReady: true,
        isPreview: false,
        isFallback: false,
        push: vi.fn().mockResolvedValue(true),
        replace: vi.fn().mockResolvedValue(true),
        prefetch: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        beforePopState: vi.fn(),
        events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
      };
      function Editor() {
        useSettingsUnsavedChanges(true);
        return <input aria-label="Draft rule" defaultValue="unfinished@example.com" />;
      }
      render(
        <RouterContext.Provider value={router}>
          <SettingsNavigationGuardProvider>
            <Editor />
            <SettingsViewportProvider value={false}>
              {label === "Back to app" ? (
                <SettingsNav activeCategory="workspace" onSelect={vi.fn()} />
              ) : (
                <SettingsMobileHeader title="Workspace access" />
              )}
            </SettingsViewportProvider>
          </SettingsNavigationGuardProvider>
        </RouterContext.Provider>
      );
      const link = screen.getByRole("link", { name: label });
      const prevented: boolean[] = [];
      const observeBrowserClick = (event: MouseEvent) => {
        prevented.push(event.defaultPrevented);
        // Record default handling after React, then suppress jsdom's unsupported navigation.
        event.preventDefault();
      };
      window.addEventListener("click", observeBrowserClick);
      try {
        for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
          fireEvent.click(link, { [modifier]: true });
        }
        link.setAttribute("target", "_blank");
        fireEvent.click(link);
        link.removeAttribute("target");
      } finally {
        window.removeEventListener("click", observeBrowserClick);
      }
      expect(prevented).toEqual([false, false, false, false, false]);
      expect(confirm).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();

      fireEvent.click(link);
      expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
      expect(router.push).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Draft rule" })).toHaveValue(
        "unfinished@example.com"
      );

      confirm.mockReturnValue(true);
      fireEvent.click(link);
      expect(router.push).toHaveBeenCalledOnce();
    }
  );
});

function renderSettingsNav(
  props: Omit<ComponentProps<typeof SettingsNav>, "onSelect"> & {
    onSelect?: ComponentProps<typeof SettingsNav>["onSelect"];
  }
) {
  return render(
    <SettingsViewportProvider value={mocks.isMobile}>
      <SettingsNav onSelect={vi.fn()} {...props} />
    </SettingsViewportProvider>
  );
}

describe("SettingsNav", () => {
  it("resolves defaults and deep links to an authorized category", () => {
    const hasNoWorkspacePermissions = () => false;

    expect(resolveSettingsCategory(null, true, hasNoWorkspacePermissions)).toBe("appearance");
    expect(resolveSettingsCategory("secrets", true, hasNoWorkspacePermissions)).toBe("appearance");
    expect(
      resolveSettingsCategory(
        "environments",
        true,
        (permission) => permission === "environments.read"
      )
    ).toBe("environments");
  });

  it("groups settings and filters labels, descriptions, and keywords", async () => {
    const user = userEvent.setup();
    renderSettingsNav({ activeCategory: "appearance" });

    expect(screen.getByRole("heading", { name: "Personal" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "request source");

    expect(screen.getByRole("button", { name: "Source control" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Appearance" })).not.toBeInTheDocument();
  });

  it("shows descriptions and opens a selected setting on mobile", async () => {
    mocks.isMobile = true;
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderSettingsNav({ activeCategory: "secrets", onSelect });

    expect(screen.getByText("Theme and code highlighting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Appearance/ }));

    expect(onSelect).toHaveBeenCalledWith("appearance", expect.any(HTMLButtonElement));
    expect(screen.getByRole("button", { name: /Secrets/ })).toHaveAttribute("aria-current", "page");
  });

  it("uses the shared focus treatment for navigation and search", () => {
    renderSettingsNav({ activeCategory: "appearance" });

    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveClass(
      "focus-visible:ring-2"
    );
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveClass("focus-visible:ring-2");
  });

  it("hides image settings when the sandbox provider does not support them", () => {
    mocks.repoImagesEnabled = false;
    renderSettingsNav({ activeCategory: "secrets" });

    expect(screen.queryByRole("button", { name: "Images" })).not.toBeInTheDocument();
  });

  it("hides settings that require unavailable permissions", () => {
    mocks.allowedPermissions = new Set();
    renderSettingsNav({ activeCategory: "appearance" });

    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workspace access" })).not.toBeInTheDocument();
  });

  it("shows Teams for a team lead without workspace management permission", () => {
    mocks.allowedPermissions = new Set();
    mocks.canEditTeam = true;
    renderSettingsNav({ activeCategory: "teams" });
    expect(screen.getByRole("button", { name: "Teams" })).toBeInTheDocument();
  });

  it.each([
    ["global secret management", ["global_secrets.manage"]],
    ["repository read and secret management", ["repositories.read", "repositories.secrets.manage"]],
  ])("shows secrets with %s", (_description, permissions) => {
    mocks.allowedPermissions = new Set(permissions);
    renderSettingsNav({ activeCategory: "secrets" });

    expect(screen.getByRole("button", { name: "Secrets" })).toBeInTheDocument();
  });

  it("hides secrets from repository secret managers without repository read access", () => {
    mocks.allowedPermissions = new Set(["repositories.secrets.manage"]);
    renderSettingsNav({ activeCategory: "appearance" });

    expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
  });

  it("shows Memories to session creators without memory management permission", () => {
    mocks.allowedPermissions = new Set(["sessions.create"]);
    renderSettingsNav({ activeCategory: "memories" });

    expect(screen.getByRole("button", { name: "Memories" })).toBeInTheDocument();
  });

  it("keeps read-level sandbox and environment panels visible", () => {
    mocks.allowedPermissions = new Set(["environments.read", "integrations.read"]);
    renderSettingsNav({ activeCategory: "environments" });

    expect(screen.getByRole("button", { name: "Environments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sandbox" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();
  });
});
