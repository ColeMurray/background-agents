// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SyntaxHighlightTheme } from "./syntax-highlight-theme";

const { setThemeMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "dark",
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
  document.head.innerHTML = "";
  window.localStorage.clear();
  setThemeMock.mockClear();
});

describe("SyntaxHighlightTheme", () => {
  it("syncs the stored color scheme preference to next-themes", async () => {
    localStorage.setItem(
      "syntax-highlight-preferences",
      JSON.stringify({ colorSchemeMode: "light" })
    );

    render(<SyntaxHighlightTheme />);

    await waitFor(() => expect(setThemeMock).toHaveBeenCalledWith("light"));
  });
});
