// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { AppearanceSettings } from "./appearance-settings";
import { APP_THEMES } from "@/lib/app-themes";

expect.extend(matchers);

const setThemeMock = vi.fn();
let themeState: string | undefined = "system";

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: themeState,
    setTheme: setThemeMock,
    resolvedTheme: themeState === "dark" ? "dark" : "light",
  }),
}));

beforeEach(() => {
  themeState = "system";
  setThemeMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

// The App theme section renders a single <select>; the Code Highlighting
// section renders two more (light/dark hljs themes). The first one belongs to
// App theme.
function appThemeSelect(): HTMLSelectElement {
  return screen.getAllByRole("combobox")[0] as HTMLSelectElement;
}

describe("AppearanceSettings — App theme picker", () => {
  const user = userEvent.setup();

  it("renders one option per registered theme", () => {
    render(<AppearanceSettings />);

    expect(screen.getByRole("heading", { name: "App theme" })).toBeInTheDocument();
    const select = appThemeSelect();
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(APP_THEMES.map((t) => t.id));
  });

  it("shows the current theme as selected", () => {
    themeState = "dark";
    render(<AppearanceSettings />);
    expect(appThemeSelect().value).toBe("dark");
  });

  it("falls back to System when next-themes returns undefined", () => {
    themeState = undefined;
    render(<AppearanceSettings />);
    expect(appThemeSelect().value).toBe("system");
  });

  it("calls setTheme when the user picks a different theme", async () => {
    render(<AppearanceSettings />);
    await user.selectOptions(appThemeSelect(), "dark");
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });

  it("supports registered named themes (e.g., 'blue')", async () => {
    // Skip the test if no custom theme is registered — the demo Blue theme can
    // be removed by deployers, and this test should adapt rather than fail.
    const customTheme = APP_THEMES.find((t) => !["light", "dark", "system"].includes(t.id));
    if (!customTheme) return;

    render(<AppearanceSettings />);
    await user.selectOptions(appThemeSelect(), customTheme.id);
    expect(setThemeMock).toHaveBeenCalledWith(customTheme.id);
  });

  it("does not warn about controlled/uncontrolled toggling on first render", () => {
    // Regression test: initially the App theme picker passed `value={undefined}`
    // until a `mounted` flag flipped, which made Radix log
    // "ToggleGroup is changing from uncontrolled to controlled". The picker is
    // a plain <select> now and the initial value is always a string, so React
    // should never log this warning.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    themeState = undefined;
    render(<AppearanceSettings />);
    const messages = errorSpy.mock.calls.map((args) => String(args[0]));
    expect(messages.some((m) => m.includes("changing from uncontrolled to controlled"))).toBe(
      false
    );
    errorSpy.mockRestore();
  });
});
