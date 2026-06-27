// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { AppearanceSettings } from "./appearance-settings";

expect.extend(matchers);

const { setThemeMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    setTheme: setThemeMock,
  }),
}));

beforeEach(() => {
  const store = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    removeItem: vi.fn((key: string) => store.delete(key)),
    clear: vi.fn(() => store.clear()),
  };

  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setThemeMock.mockClear();
});

describe("AppearanceSettings", () => {
  it("applies the selected color scheme to the app theme", async () => {
    const user = userEvent.setup();

    render(<AppearanceSettings />);

    await user.click(screen.getByText("Dark"));

    await waitFor(() => expect(setThemeMock).toHaveBeenCalledWith("dark"));
    expect(JSON.parse(localStorage.getItem("syntax-highlight-preferences") || "{}")).toMatchObject({
      colorSchemeMode: "dark",
    });

    await user.click(screen.getByText("Light"));

    expect(setThemeMock).toHaveBeenCalledWith("light");
    expect(JSON.parse(localStorage.getItem("syntax-highlight-preferences") || "{}")).toMatchObject({
      colorSchemeMode: "light",
    });
  });
});
