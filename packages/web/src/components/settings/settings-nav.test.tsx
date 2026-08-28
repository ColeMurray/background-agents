// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsNav } from "./settings-nav";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  isMobile: false,
  repoImagesEnabled: true,
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => mocks.isMobile,
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.repoImagesEnabled,
}));

afterEach(() => {
  cleanup();
  mocks.isMobile = false;
  mocks.repoImagesEnabled = true;
});

describe("SettingsNav", () => {
  it("groups settings and filters labels, descriptions, and keywords", async () => {
    const user = userEvent.setup();
    render(<SettingsNav activeCategory="appearance" onSelect={vi.fn()} />);

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
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<SettingsNav activeCategory="secrets" onSelect={onSelect} onNavigate={onNavigate} />);

    expect(screen.getByText("Theme and code highlighting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Appearance/ }));

    expect(onSelect).toHaveBeenCalledWith("appearance");
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("hides image settings when the sandbox provider does not support them", () => {
    mocks.repoImagesEnabled = false;
    render(<SettingsNav activeCategory="secrets" onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Images" })).not.toBeInTheDocument();
  });
});
