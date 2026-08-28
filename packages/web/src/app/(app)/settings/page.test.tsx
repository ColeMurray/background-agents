// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./page";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({ tab: null as string | null }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.tab ? `tab=${mocks.tab}` : ""),
}));

vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => true }));
vi.mock("@/lib/sandbox-provider", () => ({ supportsRepoImages: () => true }));

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
  window.history.replaceState(null, "", "/settings");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsPage mobile navigation", () => {
  it("pushes category selections and follows browser Back and Forward state", async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: /Appearance/ }));

    expect(screen.getByRole("heading", { name: "Appearance" })).toHaveFocus();
    expect(screen.getByText("Appearance panel")).toBeInTheDocument();
    expect(window.location.href).toContain("/settings?tab=appearance");
    expect(window.history.state).toMatchObject({ openInspectSettingsDetail: true });

    act(() => {
      window.history.replaceState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "Settings" })).toHaveFocus();
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

    render(<SettingsPage />);

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Appearance panel")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search settings" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toHaveFocus();
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("");
  });

  it("uses browser history for the in-app back action", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: /Appearance/ }));
    await user.click(screen.getByRole("button", { name: "Back to settings" }));

    expect(back).toHaveBeenCalledOnce();
  });
});
