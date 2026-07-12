// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedSidebarActions } from "./sidebar-layout";

expect.extend(matchers);

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

afterEach(cleanup);

describe("CollapsedSidebarActions", () => {
  it("keeps search and new session actions available", () => {
    const onSearchSessions = vi.fn();
    const onNewSession = vi.fn();

    render(
      <CollapsedSidebarActions onSearchSessions={onSearchSessions} onNewSession={onNewSession} />
    );

    fireEvent.click(screen.getByRole("button", { name: /Search sessions/ }));
    fireEvent.click(screen.getByRole("button", { name: /New session/ }));

    expect(onSearchSessions).toHaveBeenCalledOnce();
    expect(onNewSession).toHaveBeenCalledOnce();
  });
});
