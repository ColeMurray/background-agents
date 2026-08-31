// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./page";
import { SettingsViewportProvider } from "@/components/settings/settings-viewport-context";
import { PERMISSION_IDS } from "@open-inspect/shared/rbac";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  tab: null as string | null,
  repoImagesEnabled: true,
  allowedPermissions: new Set<string>(),
  authorization: { permissions: [] as string[] },
  hasPermission: (permission: string) => mocks.allowedPermissions.has(permission),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.tab ? `tab=${mocks.tab}` : ""),
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.repoImagesEnabled,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: mocks.authorization,
    loading: false,
    hasPermission: mocks.hasPermission,
  }),
}));

vi.mock("@/components/settings/secrets-settings", () => ({
  SecretsSettings: () => <div>Secrets panel</div>,
}));
vi.mock("@/components/settings/environments-settings", () => ({
  EnvironmentsSettings: () => <div>Environments panel</div>,
}));
vi.mock("@/components/settings/models-settings", () => ({
  ModelsSettings: () => <div>Models panel</div>,
}));
vi.mock("@/components/settings/provider-accounts-settings", () => ({
  ProviderAccountsSettings: () => <div>Accounts panel</div>,
}));
vi.mock("@/components/settings/images-settings", () => ({
  ImagesSettings: () => <div>Images panel</div>,
}));
vi.mock("@/components/settings/appearance-settings", () => ({
  AppearanceSettings: () => <div>Appearance panel</div>,
}));
vi.mock("@/components/settings/keyboard-shortcuts-settings", () => ({
  KeyboardShortcutsSettings: () => <div>Keyboard panel</div>,
}));
vi.mock("@/components/settings/data-controls-settings", () => ({
  DataControlsSettings: () => <div>Data controls panel</div>,
}));
vi.mock("@/components/settings/sandbox-settings", () => ({
  SandboxSettingsPage: () => <div>Sandbox panel</div>,
}));
vi.mock("@/components/settings/scm-settings", () => ({
  ScmSettingsPage: () => <div>Source control panel</div>,
}));
vi.mock("@/components/settings/integrations-settings", () => ({
  IntegrationsSettings: () => <div>Integrations panel</div>,
}));
vi.mock("@/components/settings/skills-settings", () => ({
  SkillsSettings: () => <div>Skills panel</div>,
}));
vi.mock("@/components/settings/mcp-servers-settings", () => ({
  McpServersSettings: () => <div>MCP servers panel</div>,
}));

beforeEach(() => {
  mocks.tab = null;
  mocks.repoImagesEnabled = true;
  mocks.allowedPermissions = new Set(PERMISSION_IDS);
  mocks.authorization.permissions = [...PERMISSION_IDS];
  window.history.replaceState(null, "", "/settings");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

function renderSettingsPage() {
  return render(
    <SettingsViewportProvider value={true}>
      <SettingsPage />
    </SettingsViewportProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsPage mobile navigation", () => {
  it("pushes category selections and follows browser Back and Forward state", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await user.click(screen.getByRole("button", { name: /Appearance/ }));

    expect(await screen.findByRole("heading", { name: "Appearance" })).toHaveFocus();
    expect(await screen.findByText("Appearance panel")).toBeInTheDocument();
    expect(window.location.href).toContain("/settings?tab=appearance");
    expect(window.history.state).toMatchObject({ openInspectSettingsDetail: true });

    act(() => {
      window.history.replaceState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("button", { name: /Appearance/ })).toHaveFocus();
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("");

    act(() => {
      window.history.replaceState(
        { openInspectSettingsDetail: true },
        "",
        "/settings?tab=appearance"
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "Appearance" })).toHaveFocus();
    expect(screen.getByText("Appearance panel")).toBeInTheDocument();
  });

  it("returns a direct deep link to the settings root", async () => {
    mocks.tab = "appearance";
    window.history.replaceState(null, "", "/settings?tab=appearance");
    const user = userEvent.setup();

    renderSettingsPage();

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Appearance panel")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search settings" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toHaveFocus();
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("");
  });

  it("redirects an unauthorized deep link to the first available panel", () => {
    mocks.tab = "secrets";
    mocks.allowedPermissions = new Set();
    mocks.authorization.permissions = [];
    window.history.replaceState(null, "", "/settings?tab=secrets");

    renderSettingsPage();

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Appearance panel")).toBeInTheDocument();
    expect(screen.queryByText("Secrets panel")).not.toBeInTheDocument();
  });

  it("allows repository secret managers to open secrets", async () => {
    mocks.tab = "secrets";
    mocks.allowedPermissions = new Set(["repositories.secrets.manage", "repositories.read"]);
    mocks.authorization.permissions = ["repositories.secrets.manage", "repositories.read"];
    window.history.replaceState(null, "", "/settings?tab=secrets");

    renderSettingsPage();

    expect(await screen.findByText("Secrets panel")).toBeInTheDocument();
  });

  it("rejects repository secret managers without repository read access", async () => {
    mocks.tab = "secrets";
    mocks.allowedPermissions = new Set(["repositories.secrets.manage"]);
    mocks.authorization.permissions = ["repositories.secrets.manage"];
    window.history.replaceState(null, "", "/settings?tab=secrets");

    renderSettingsPage();

    expect(await screen.findByText("Appearance panel")).toBeInTheDocument();
    expect(screen.queryByText("Secrets panel")).not.toBeInTheDocument();
  });

  it("uses browser history for the in-app back action", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderSettingsPage();

    await user.click(screen.getByRole("button", { name: /Appearance/ }));
    await user.click(screen.getByRole("button", { name: "Back to settings" }));

    expect(back).toHaveBeenCalledOnce();
  });

  it("preserves the mobile search and restores focus to the selected category", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    const search = screen.getByRole("searchbox", { name: "Search settings" });
    await user.type(search, "theme");
    await user.click(screen.getByRole("button", { name: /Appearance/ }));

    act(() => {
      window.history.replaceState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveValue("theme");
    expect(screen.getByRole("button", { name: /Appearance/ })).toHaveFocus();
  });

  it.each([
    { description: "invalid", tab: "bogus", repoImagesEnabled: true },
    { description: "unavailable", tab: "images", repoImagesEnabled: false },
  ])("returns focus to the list for an $description history tab", ({ tab, repoImagesEnabled }) => {
    mocks.repoImagesEnabled = repoImagesEnabled;
    renderSettingsPage();

    act(() => {
      window.history.replaceState(null, "", `/settings?tab=${tab}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "Settings" })).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeInTheDocument();
  });
});
