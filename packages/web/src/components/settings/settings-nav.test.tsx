// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsNav } from "./settings-nav";
import { SettingsViewportProvider } from "./settings-viewport-context";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  isMobile: false,
  repoImagesEnabled: true,
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.repoImagesEnabled,
}));

afterEach(() => {
  cleanup();
  mocks.isMobile = false;
  mocks.repoImagesEnabled = true;
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
});
